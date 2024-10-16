import Cors from "@fastify/cors";
import Websocket from "@fastify/websocket";
import KeyvSqlite from "@keyv/sqlite";
import Fastify from "fastify";
import Keyv from "keyv";
import { uuidv7 } from "uuidv7";
import { pubsub } from "../src/pubsub";

const keyvStore = new KeyvSqlite("sqlite://.data/database.sqlite");

const audioDb = new Keyv({ store: keyvStore, namespace: "audio" });
function getRoomMetadataDb(room: string) {
  return new Keyv({ store: keyvStore, namespace: `room_${room}` });
}

const fastify = Fastify({
  logger: true,
});
await fastify.register(Websocket);
await fastify.register(Cors);

class Utterance {
  id = uuidv7();
  start = new Date().toISOString();
  buffers: Buffer[] = [];
  constructor(public room: string) {
    pubsub.publish(room, "audio_start", { id: this.id });
    getRoomMetadataDb(this.room).set(this.id, {
      start: this.start,
    });
    pubsub.publish(`public/${room}`, "updated", { id: this.id });
  }
  addAudio(base64: string) {
    this.buffers.push(Buffer.from(base64, "base64"));
    pubsub.publish(this.room, "audio_data", { id: this.id, base64 });
  }
  finish() {
    pubsub.publish(this.room, "audio_finish", { id: this.id });
    const buffer = Buffer.concat(this.buffers);
    getRoomMetadataDb(this.room).set(this.id, {
      start: this.start,
      finish: new Date().toISOString(),
      length: buffer.length,
    });
    audioDb.set(this.id, buffer.toString("base64"));
    pubsub.publish(`public/${this.room}`, "updated", { id: this.id });
  }
}

fastify.get("/rooms/:room/audio", { websocket: true }, (connection, req) => {
  const token = (req.query as Record<string, string>).token;
  const room = (req.params as { room: string }).room;
  if (token !== process.env["SERVICE_TOKEN"]) {
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
        connection.send(JSON.stringify({ id: data.id, error: String(error) }));
        req.log.error(error);
      }
    } catch (error) {
      req.log.error(error);
    }
  });
  connection.send(JSON.stringify({ method: "welcome" }));
});

fastify.get("/rooms/:room/events", { websocket: true }, (connection, req) => {
  const token = (req.query as Record<string, string>).token;
  const room = (req.params as { room: string }).room;
  if (token !== process.env["SERVICE_TOKEN"]) {
    connection.send(JSON.stringify({ error: "Invalid token" }));
    connection.close();
    return;
  }
  const unsubscribe = pubsub.subscribe(room, (message) => {
    connection.send(message);
  });
  connection.on("close", unsubscribe);
});

fastify.get(
  "/rooms/:room/publicEvents",
  { websocket: true },
  (connection, req) => {
    const room = (req.params as { room: string }).room;
    const unsubscribe = pubsub.subscribe(`public/${room}`, (message) => {
      connection.send(message);
    });
    connection.on("close", unsubscribe);
  }
);

function iterate(keyv: Keyv) {
  return (keyv.iterator as any)() as AsyncIterable<any>;
}

fastify.get("/rooms/:room/items", async (req) => {
  const room = (req.params as { room: string }).room;
  const output = [];
  for await (const [id, data] of iterate(getRoomMetadataDb(room))) {
    output.push({ id, ...data });
  }
  return output;
});

fastify.get("/rooms/:room/items/:id", async (req) => {
  const room = (req.params as { room: string }).room;
  const id = (req.params as { id: string }).id;
  const db = getRoomMetadataDb(room);
  return { ...(await db.get(id)), id };
});

fastify.patch("/rooms/:room/items/:id", async (req) => {
  const token = req.headers["authorization"]!.split(" ")[1];
  if (token !== process.env["SERVICE_TOKEN"]) {
    return;
  }
  const room = (req.params as { room: string }).room;
  const id = (req.params as { id: string }).id;
  const db = getRoomMetadataDb(room);
  const value = await db.get(id);
  const body = req.body as any;
  const newValue = {
    ...value,
    ...body,
    changes: [
      ...(value.changes ?? []),
      { payload: body, time: new Date().toISOString() },
    ],
  };
  await db.set(id, newValue);
  // const listeners = getListenerSet(`public/${room}`);
  // broadcast(listeners, "updated", { id });
  pubsub.publish(`public/${room}`, "updated", { id });
  return newValue;
});

fastify.post("/rooms/:room/items/:id/partial", async (req) => {
  const token = req.headers["authorization"]!.split(" ")[1];
  if (token !== process.env["SERVICE_TOKEN"]) {
    return;
  }
  const room = (req.params as { room: string }).room;
  const id = (req.params as { id: string }).id;
  const body = req.body as { transcript: string };
  pubsub.publish(`public/${room}`, "partial_transcript", {
    id,
    transcript: body.transcript,
  });
  return { ok: true };
});

fastify.get("/pcm/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const buffer = Buffer.from((await audioDb.get(id)) as string, "base64");
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

fastify.listen({ port: 10300, host: "0.0.0.0" });
