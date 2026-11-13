import type { ServerWebSocket } from "bun";
import { decodeChunkFrame, type ClientMessage, type ServerMessage } from "../shared/protocol.ts";
import type { RoomService, StreamRecord } from "./rooms.ts";
import type { Transcriber } from "./transcriber.ts";

export interface IngestSocketData {
  kind: "ingest";
  roomId: string;
  stream: StreamRecord | null;
  pending: { seq: number; payload: Uint8Array }[];
  flushScheduled: boolean;
  pings: Map<number, { perf: number; epoch: number }>;
  nextPingId: number;
  pingTimer: ReturnType<typeof setInterval> | null;
}

export function ingestSocketData(roomId: string): IngestSocketData {
  return {
    kind: "ingest",
    roomId,
    stream: null,
    pending: [],
    flushScheduled: false,
    pings: new Map(),
    nextPingId: 1,
    pingTimer: null,
  };
}

export interface IngestOptions {
  pingIntervalMs: number;
}

/** Handles the sender WebSocket: auth, chunk storage and acks, clock sync. */
export function createIngestHandler(rooms: RoomService, transcriber: Transcriber, options: IngestOptions) {
  const send = (ws: ServerWebSocket<IngestSocketData>, message: ServerMessage) => ws.send(JSON.stringify(message));

  const fail = (ws: ServerWebSocket<IngestSocketData>, message: string) => {
    send(ws, { type: "error", message });
    ws.close(4000, message.slice(0, 100));
  };

  const ping = (ws: ServerWebSocket<IngestSocketData>) => {
    const id = ws.data.nextPingId++;
    ws.data.pings.set(id, { perf: performance.now(), epoch: Date.now() });
    // Forget pings that were never answered.
    if (ws.data.pings.size > 10) ws.data.pings.delete(ws.data.pings.keys().next().value!);
    send(ws, { type: "ping", id });
  };

  const flush = (ws: ServerWebSocket<IngestSocketData>) => {
    ws.data.flushScheduled = false;
    const stream = ws.data.stream;
    const chunks = ws.data.pending;
    ws.data.pending = [];
    if (!stream || chunks.length === 0) return;
    try {
      const next = rooms.appendChunks(stream, chunks);
      send(ws, { type: "ack", next });
      transcriber.notify(stream.id);
    } catch (error) {
      fail(ws, (error as Error).message);
    }
  };

  return {
    open(_ws: ServerWebSocket<IngestSocketData>) {},

    message(ws: ServerWebSocket<IngestSocketData>, raw: string | Buffer) {
      if (typeof raw !== "string") {
        if (!ws.data.stream) return fail(ws, "Send hello first");
        ws.data.pending.push(decodeChunkFrame(new Uint8Array(raw)));
        // Batch the frames that arrive together into one disk write and one ack.
        if (!ws.data.flushScheduled) {
          ws.data.flushScheduled = true;
          setTimeout(() => flush(ws), 0);
        }
        return;
      }
      let message: ClientMessage;
      try {
        message = JSON.parse(raw);
      } catch {
        return fail(ws, "Bad JSON");
      }
      switch (message.type) {
        case "hello": {
          if (!rooms.checkPassword(ws.data.roomId, message.password)) return fail(ws, "Wrong room password");
          if (!/^[\w-]{8,64}$/.test(message.streamId)) return fail(ws, "Bad stream id");
          if (message.format !== "pcm16" && message.format !== "opus") return fail(ws, "Bad format");
          try {
            ws.data.stream = rooms.openStream(ws.data.roomId, message.streamId, message.format);
          } catch (error) {
            return fail(ws, (error as Error).message);
          }
          send(ws, { type: "ready", next: ws.data.stream.chunkCount });
          ping(ws);
          ws.data.pingTimer = setInterval(() => ping(ws), options.pingIntervalMs);
          break;
        }
        case "pong": {
          const sent = ws.data.pings.get(message.id);
          if (!sent || !ws.data.stream) return;
          ws.data.pings.delete(message.id);
          const rtt = performance.now() - sent.perf;
          // The client read its clock roughly halfway through the round trip.
          const startedAt = Math.round(sent.epoch + rtt / 2 - message.elapsed);
          rooms.updateClock(ws.data.stream.id, startedAt, Math.round(rtt));
          break;
        }
        case "end": {
          if (!ws.data.stream) return;
          flush(ws);
          rooms.endStream(ws.data.stream.id);
          transcriber.notify(ws.data.stream.id);
          break;
        }
      }
    },

    close(ws: ServerWebSocket<IngestSocketData>) {
      if (ws.data.pingTimer) clearInterval(ws.data.pingTimer);
      flush(ws);
    },
  };
}
