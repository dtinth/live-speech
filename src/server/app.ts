import type { BunRequest, HTMLBundle, Server } from "bun";
import { CHUNK_MS, PCM_CHUNK_BYTES } from "../shared/protocol.ts";
import { orderedSegments } from "../shared/transcript.ts";
import { AudioStore } from "./audioStore.ts";
import type { SockudoClientConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { createChunkDecoder } from "./decoder.ts";
import { createIngestHandler, ingestSocketData, type IngestSocketData } from "./ingest.ts";
import type { Publisher } from "./publisher.ts";
import { RoomService, safeEqual, type Room } from "./rooms.ts";
import { Transcriber, type TranscriberOptions } from "./transcriber.ts";
import type { TranscriptionProvider } from "./transcription/provider.ts";
import { wavHeader } from "./wav.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AppOptions {
  port: number;
  dataDir: string;
  masterPassword: string;
  provider: TranscriptionProvider;
  publisher: Publisher;
  /** What the browser needs to subscribe to Sockudo; null means viewers poll. */
  sockudoClient: SockudoClientConfig | null;
  transcriber?: Partial<TranscriberOptions>;
  pingIntervalMs?: number;
  /** Frontend pages (Bun HTML imports). Tests leave them out. */
  pages?: { admin: HTMLBundle; viewer: HTMLBundle; sender: HTMLBundle };
  development?: boolean;
}

export interface App {
  server: Server<IngestSocketData>;
  url: URL;
  rooms: RoomService;
  transcriber: Transcriber;
  stop(): Promise<void>;
}

/** Keeps any one event well under Sockudo's per-event payload limit. */
const MAX_SEGMENT_TEXT = 10_000;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (status: number, message: string) => json({ error: message }, status);

function bearer(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

export function startApp(options: AppOptions): App {
  const db = openDatabase(options.dataDir);
  const audio = new AudioStore(db);
  const rooms = new RoomService(db, audio, options.publisher);
  const transcriber = new Transcriber(rooms, audio, options.provider, {
    catchUpSpeed: 1.5,
    idleMs: 5000,
    retryMs: 2000,
    ...options.transcriber,
  });
  const ingest = createIngestHandler(rooms, transcriber, { pingIntervalMs: options.pingIntervalMs ?? 2000 });

  const isAdmin = (req: Request) => safeEqual(bearer(req), options.masterPassword);

  /** Runs `handler` with the room, or answers 404. */
  const withRoom =
    <P extends string>(handler: (req: BunRequest<P>, room: Room) => Response | Promise<Response>) =>
    (req: BunRequest<P>) => {
      const room = rooms.getRoom((req.params as Record<string, string>).roomId!);
      return room ? handler(req, room) : error(404, "No such room");
    };

  const withRoomPassword =
    <P extends string>(handler: (req: BunRequest<P>, room: Room) => Response | Promise<Response>) =>
    withRoom<P>((req, room) =>
      safeEqual(bearer(req), room.password) || isAdmin(req) ? handler(req, room) : error(401, "Wrong room password"),
    );

  const publicRoom = (room: Room) => ({ id: room.id, name: room.name, createdAt: room.createdAt });

  const adminRoom = (room: Room) => ({
    ...room,
    streams: rooms.listStreams(room.id).map((s) => ({
      id: s.id,
      format: s.format,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      clockRtt: s.clockRtt,
      durationMs: s.chunkCount * CHUNK_MS,
      transcribedMs: s.transcribedUntil * CHUNK_MS,
      ended: s.ended,
    })),
  });

  const snapshot = (room: Room) => ({
    room: publicRoom(room),
    transcript: rooms.getTranscript(room.id),
    partials: rooms.getPartials(room.id),
  });

  const transcriptText = (room: Room) => {
    const state = rooms.getTranscript(room.id);
    return orderedSegments(state)
      .map((s) => s.text)
      .join("\n");
  };

  const pages = options.pages && {
    "/": options.pages.admin,
    "/rooms/:roomId": options.pages.viewer,
    "/rooms/:roomId/send": options.pages.sender,
  };
  const server = Bun.serve({
    port: options.port,
    development: options.development ?? false,
    routes: {
      ...(pages as unknown as {}),

      "/api/health": () => json({ ok: true }),

      "/api/config": () => json({ sockudo: options.sockudoClient }),

      // Admin (master password)

      "/api/admin/rooms": {
        GET: (req) => (isAdmin(req) ? json(rooms.listRooms().map(adminRoom)) : error(401, "Wrong master password")),
        POST: async (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          const body = (await req.json().catch(() => ({}))) as { name?: string };
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) return error(400, "Room name is required");
          if (name.length > 200) return error(400, "Room name is too long");
          return json(adminRoom(rooms.createRoom(name)), 201);
        },
      },

      "/api/admin/rooms/:roomId": {
        DELETE: (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          if (!rooms.getRoom(req.params.roomId)) return error(404, "No such room");
          transcriber.forget(rooms.listStreams(req.params.roomId).map((s) => s.id));
          ingest.disconnectRoom(req.params.roomId, "Room deleted");
          rooms.deleteRoom(req.params.roomId);
          return json({ deleted: true });
        },
      },

      "/api/admin/rooms/:roomId/password": {
        POST: (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          const room = rooms.regeneratePassword(req.params.roomId);
          if (!room) return error(404, "No such room");
          ingest.disconnectRoom(room.id, "Room password changed");
          return json(adminRoom(room));
        },
      },

      "/api/admin/rooms/:roomId/export": {
        GET: (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          const room = rooms.getRoom(req.params.roomId);
          if (!room) return error(404, "No such room");
          const dir = mkdtempSync(join(tmpdir(), "live-speech-export-"));
          const path = join(dir, `${room.id}.sqlite`);
          try {
            rooms.exportRoom(room.id, path);
          } catch (e) {
            rmSync(dir, { recursive: true, force: true });
            throw e;
          }
          const file = Bun.file(path);
          // Read it into memory so the temp file can go right away; an Opus
          // room is ~15 MB per recorded hour.
          return file.arrayBuffer().then((bytes) => {
            rmSync(dir, { recursive: true, force: true });
            return new Response(bytes, {
              headers: {
                "content-type": "application/vnd.sqlite3",
                "content-disposition": `attachment; filename="live-speech-${room.id}.sqlite"`,
              },
            });
          });
        },
      },

      // Public reads

      "/api/rooms/:roomId": withRoom((_req, room) => json(snapshot(room))),

      "/api/rooms/:roomId/events": withRoom((req, room) => {
        const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
        const events = rooms.eventsSince(room.id, after);
        return json({ events, seq: rooms.getTranscript(room.id).seq, partials: rooms.getPartials(room.id) });
      }),

      "/api/rooms/:roomId/transcript.txt": withRoom(
        (_req, room) => new Response(transcriptText(room), { headers: { "content-type": "text/plain; charset=utf-8" } }),
      ),

      "/api/rooms/:roomId/transcript.json": withRoom((_req, room) => {
        const state = rooms.getTranscript(room.id);
        return json({
          room: publicRoom(room),
          seq: state.seq,
          segments: orderedSegments(state).map((s) => ({
            id: s.id,
            streamId: s.streamId,
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            edited: s.versions.length > 1,
          })),
          partials: rooms.getPartials(room.id),
        });
      }),

      "/api/rooms/:roomId/streams/:streamId/audio.wav": withRoom((req, room) => {
        const stream = rooms.getStream(req.params.streamId);
        if (!stream || stream.roomId !== room.id) return error(404, "No such stream");
        const search = new URL(req.url).searchParams;
        const fromSeq = Math.max(0, Math.floor(Number(search.get("from") ?? 0) / CHUNK_MS) || 0);
        const toSeq = Math.min(stream.chunkCount, Math.ceil(Number(search.get("to") ?? Infinity) / CHUNK_MS) || 0);
        const chunks = Math.max(0, toSeq - fromSeq);
        // Decode a page at a time as the client reads, so a day-long stream
        // neither sits in memory nor blocks the event loop. Opus decoding
        // starting mid-stream costs a few ms of warm-up, fine for listening.
        const decoder = createChunkDecoder(stream.format);
        let next = fromSeq;
        let headerSent = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            // Let acks and other requests run between pages.
            await new Promise((resolve) => setImmediate(resolve));
            if (!headerSent) {
              headerSent = true;
              controller.enqueue(wavHeader(chunks * PCM_CHUNK_BYTES));
              return;
            }
            const page: Uint8Array[] = [];
            for (const chunk of audio.read(stream.id, { fromSeq: next, toSeq: Math.min(toSeq, next + 100) })) {
              // Fill any hole with silence so the WAV keeps the stream's timing.
              while (next < chunk.seq) {
                page.push(new Uint8Array(PCM_CHUNK_BYTES));
                next++;
              }
              page.push(decoder.decode(chunk.payload));
              next = chunk.seq + 1;
            }
            const pageEnd = Math.min(toSeq, next + (page.length ? 0 : 100));
            while (next < pageEnd) {
              page.push(new Uint8Array(PCM_CHUNK_BYTES));
              next++;
            }
            if (page.length) controller.enqueue(Buffer.concat(page));
            if (next >= toSeq) {
              decoder.dispose();
              controller.close();
            }
          },
          cancel() {
            decoder.dispose();
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "audio/wav",
            "content-length": String(44 + chunks * PCM_CHUNK_BYTES),
          },
        });
      }),

      // Room password

      "/api/rooms/:roomId/auth": {
        POST: withRoomPassword((_req, room) => json({ ok: true, room: publicRoom(room) })),
      },

      "/api/rooms/:roomId/segments/:segmentId": {
        GET: withRoom((req, room) => {
          const segments = rooms.getTranscript(room.id).segments;
          const segment = Object.hasOwn(segments, req.params.segmentId) ? segments[req.params.segmentId] : undefined;
          return segment ? json(segment) : error(404, "No such segment");
        }),
        PATCH: withRoomPassword(async (req, room) => {
          const segments = rooms.getTranscript(room.id).segments;
          const segment = Object.hasOwn(segments, req.params.segmentId) ? segments[req.params.segmentId] : undefined;
          if (!segment) return error(404, "No such segment");
          const body = (await req.json().catch(() => ({}))) as { text?: unknown; author?: unknown; revertTo?: unknown };
          let text: string;
          if (typeof body.revertTo === "number") {
            const version = segment.versions.find((v) => v.seq === body.revertTo);
            if (!version) return error(400, "No such version");
            text = version.text;
          } else if (typeof body.text === "string") {
            if (body.text.length > MAX_SEGMENT_TEXT) return error(413, `Text is limited to ${MAX_SEGMENT_TEXT} characters`);
            text = body.text;
          } else {
            return error(400, "Send { text } or { revertTo: <version seq> }");
          }
          const author = typeof body.author === "string" && body.author.trim() ? body.author.trim().slice(0, 100) : "anonymous";
          if (text === segment.text) return json(segment);
          rooms.appendEvent(room.id, { type: "segment.edited", segmentId: segment.id, text, author });
          return json(rooms.getTranscript(room.id).segments[segment.id]);
        }),
      },

      "/api/rooms/:roomId/ingest": (req, server) => {
        if (!rooms.getRoom(req.params.roomId)) return error(404, "No such room");
        if (server.upgrade(req, { data: ingestSocketData(req.params.roomId) })) return undefined as unknown as Response;
        return error(400, "Expected a WebSocket");
      },
    },
    fetch() {
      return error(404, "Not found");
    },
    websocket: {
      data: {} as IngestSocketData,
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 60,
      open: ingest.open,
      message: ingest.message,
      close: ingest.close,
    },
  });

  transcriber.resumeAll();

  return {
    server,
    url: server.url,
    rooms,
    transcriber,
    async stop() {
      transcriber.stop();
      await server.stop(true);
      await rooms.flushPublishes();
      db.close();
    },
  };
}
