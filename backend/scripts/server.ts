import Cors from "@fastify/cors";
import Websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { db } from "../src/db";
import { getItem, getItems, updateItem } from "../src/itemOperations";
import { publicBroadcast } from "../src/publicBroadcast";
import { pubsub } from "../src/pubsub";
import { Room } from "../src/room";
import { Utterance } from "../src/utterance";

const fastify = Fastify({
  logger: true,
});
await fastify.register(Websocket);

// Add `Access-Control-Allow-Private-Network: true` to all responses
fastify.addHook("onSend", (request, reply, payload, done) => {
  reply.header("Access-Control-Allow-Private-Network", "true");
  done();
});

await fastify.register(Cors);

fastify.post("/admin/rooms", async (req, reply) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (token !== process.env["SERVICE_TOKEN"]) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  const roomId = uuidv7();
  const roomKey = randomBytes(32).toString("hex");

  await db.rooms.set(roomId, { roomKey });

  return { roomId, roomKey };
});

fastify.get("/admin/rooms", async (req, reply) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (token !== process.env["SERVICE_TOKEN"]) {
    reply.code(401).send({ error: "Unauthorized" });
    return;
  }

  const rooms = [];
  for await (const [roomId, roomData] of db.rooms) {
    rooms.push({ roomId, ...roomData });
  }

  return rooms;
});

async function checkRoomKey(room: Room, key: string) {
  const roomInfo = await db.rooms.get(room.name);
  if (!roomInfo) {
    return false;
  }
  return roomInfo.roomKey === key;
}

async function validateRoomKey(
  req: FastifyRequest,
  room: Room
): Promise<boolean> {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return false;

  const [bearer, key] = authHeader.split(" ");
  if (bearer !== "Bearer" || !key) return false;

  return checkRoomKey(room, key);
}

fastify.get(
  "/rooms/:room/audioIngest",
  { websocket: true },
  async (connection, req) => {
    const key = (req.query as { key: string }).key;
    const room = new Room((req.params as { room: string }).room);
    if (!(await checkRoomKey(room, key))) {
      connection.send(JSON.stringify({ error: "Invalid token" }));
      connection.close();
      return;
    }

    let currentUtterance: Utterance | undefined;
    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());
        // JSON-RPC messages:
        // - "start" - start audio stream.
        // - "audio" - audio data. params.data is base64-encoded s16le audio data.
        // - "stop" - stop audio stream.
        // Send acknowledgement for each message.
        try {
          switch (data.method) {
            case "start": {
              currentUtterance = new Utterance(room);
              break;
            }
            case "audio": {
              currentUtterance?.addAudio(data.params.data);
              break;
            }
            case "stop": {
              currentUtterance?.finish();
              break;
            }
          }
          connection.send(JSON.stringify({ id: data.id, result: null }));
        } catch (error) {
          connection.send(
            JSON.stringify({ id: data.id, error: String(error) })
          );
          req.log.error(error);
        }
      } catch (error) {
        req.log.error(error);
      }
    });
    connection.send(JSON.stringify({ method: "welcome" }));
  }
);

fastify.get(
  "/rooms/:room/audioEvents",
  { websocket: true },
  async (connection, req) => {
    const key = (req.query as Record<string, string>).key;
    const room = new Room((req.params as { room: string }).room);
    if (!(await checkRoomKey(room, key))) {
      connection.send(JSON.stringify({ error: "Invalid room key" }));
      connection.close();
      return;
    }
    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.method === "submit_partial_transcript") {
          const { id, transcript } = data.params;
          publicBroadcast(room, "partial_transcript", {
            id,
            transcript,
          });
          connection.send(
            JSON.stringify({ id: data.id, result: { ok: true } })
          );
        }
      } catch (error) {
        req.log.error(error);
      }
    });
    const unsubscribe = pubsub.subscribe(room.audioTopic, (message) => {
      connection.send(message);
    });
    connection.on("close", unsubscribe);
  }
);

fastify.get(
  "/rooms/:room/publicEvents",
  { websocket: true },
  (connection, req) => {
    const room = new Room((req.params as { room: string }).room);
    const unsubscribe = pubsub.subscribe(room.publicTopic, (message) => {
      connection.send(message);
    });
    connection.on("close", unsubscribe);
  }
);

fastify.get("/rooms/:room/items", async (req) => {
  const room = new Room((req.params as { room: string }).room);
  const items = await getItems(room);
  return items;
});

fastify.get("/rooms/:room/items/:id", async (req, reply) => {
  const room = new Room((req.params as { room: string }).room);
  const id = (req.params as { id: string }).id;
  const item = await getItem(room, id);
  if (!item) {
    reply.status(404).send({ error: "Not found" });
    return;
  }
  return item;
});

fastify.patch("/rooms/:room/items/:id", async (req, reply) => {
  const room = new Room((req.params as { room: string }).room);
  if (!(await validateRoomKey(req, room))) {
    reply.code(401).send({ error: "Invalid room key" });
    return;
  }
  const id = (req.params as { id: string }).id;
  const body = req.body as any;
  const newValue = await updateItem(room, id, body);
  return newValue;
});

fastify.get("/pcm/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const buffer = Buffer.from((await db.audio.get(id)) as string, "base64");
  // Generate wav file. Buffer is raw PCM, s16le, 1 channel.
  const sampleRate = 16000; // Assuming 16kHz sample rate
  const numChannels = 1;
  const bitsPerSample = 16;

  const dataSize = buffer.length;
  const wavBuffer = Buffer.alloc(44 + dataSize);

  // WAV header
  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataSize, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(numChannels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28);
  wavBuffer.writeUInt16LE((numChannels * bitsPerSample) / 8, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataSize, 40);

  // Copy PCM data
  buffer.copy(wavBuffer, 44);

  reply
    .header("Content-Type", "audio/wav")
    .header("Content-Disposition", `inline; filename="${id}.wav"`)
    .send(wavBuffer);
});

fastify.listen({ port: 10300 });
