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

  const sockets = new Set<ServerWebSocket<IngestSocketData>>();

  const handleText = (ws: ServerWebSocket<IngestSocketData>, raw: string) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return fail(ws, "Bad JSON");
    }
    if (!message || typeof message !== "object") return fail(ws, "Bad message");
    switch (message.type) {
      case "hello": {
        if (ws.data.stream) return fail(ws, "Already said hello; use one connection per stream");
        if (typeof message.password !== "string" || !rooms.checkPassword(ws.data.roomId, message.password)) {
          return fail(ws, "Wrong room password");
        }
        if (typeof message.streamId !== "string" || !/^[\w-]{8,64}$/.test(message.streamId)) {
          return fail(ws, "Bad stream id");
        }
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
        if (typeof message.id !== "number" || typeof message.elapsed !== "number" || !Number.isFinite(message.elapsed)) {
          return;
        }
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
  };

  const handleBinary = (ws: ServerWebSocket<IngestSocketData>, raw: Buffer) => {
    if (!ws.data.stream) return fail(ws, "Send hello first");
    if (raw.byteLength < 4) return fail(ws, "Chunk frame too short");
    ws.data.pending.push(decodeChunkFrame(new Uint8Array(raw)));
    // Batch the frames that arrive together into one disk write and one ack.
    if (!ws.data.flushScheduled) {
      ws.data.flushScheduled = true;
      setTimeout(() => flush(ws), 0);
    }
  };

  return {
    open(ws: ServerWebSocket<IngestSocketData>) {
      sockets.add(ws);
    },

    message(ws: ServerWebSocket<IngestSocketData>, raw: string | Buffer) {
      // Anyone can open this socket, so nothing a client sends may throw out
      // of here: an uncaught error would take down every room.
      try {
        if (typeof raw === "string") handleText(ws, raw);
        else handleBinary(ws, raw);
      } catch (error) {
        console.error("[ingest]", error);
        fail(ws, "Internal error");
      }
    },

    close(ws: ServerWebSocket<IngestSocketData>) {
      sockets.delete(ws);
      if (ws.data.pingTimer) clearInterval(ws.data.pingTimer);
      try {
        flush(ws);
      } catch (error) {
        console.error("[ingest]", error);
      }
    },

    /** Cuts off a room's senders, e.g. after its password changes. */
    disconnectRoom(roomId: string, reason: string) {
      for (const ws of sockets) if (ws.data.roomId === roomId) fail(ws, reason);
    },
  };
}
