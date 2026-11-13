import type { BunRequest, HTMLBundle, Server } from "bun";
import { CHUNK_MS } from "../shared/protocol.ts";
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
          const name = body.name?.trim();
          if (!name) return error(400, "Room name is required");
          return json(adminRoom(rooms.createRoom(name)), 201);
        },
      },

      "/api/admin/rooms/:roomId": {
        DELETE: (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          if (!rooms.getRoom(req.params.roomId)) return error(404, "No such room");
          rooms.deleteRoom(req.params.roomId);
          return json({ deleted: true });
        },
      },

      "/api/admin/rooms/:roomId/password": {
        POST: (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          const room = rooms.regeneratePassword(req.params.roomId);
          return room ? json(adminRoom(room)) : error(404, "No such room");
        },
      },

      "/api/admin/rooms/:roomId/export": {
        GET: (req) => {
          if (!isAdmin(req)) return error(401, "Wrong master password");
          const room = rooms.getRoom(req.params.roomId);
          if (!room) return error(404, "No such room");
          return json({
            room,
            streams: rooms.listStreams(room.id),
            events: rooms.eventsSince(room.id, 0, Number.MAX_SAFE_INTEGER),
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
        const fromSeq = Math.max(0, Math.floor(Number(search.get("from") ?? 0) / CHUNK_MS));
        const toSeq = Math.min(stream.chunkCount, Math.ceil(Number(search.get("to") ?? Infinity) / CHUNK_MS));
        // Opus needs decoding from the start of the stream to stay in sync, but
        // each 100 ms chunk is independent enough that starting mid-stream only
        // costs a few ms of warm-up, which is fine for listening back.
        const decoder = createChunkDecoder(stream.format);
        const parts: Uint8Array[] = [];
        for (const chunk of audio.read(stream.id, { fromSeq, toSeq })) {
          parts.push(decoder.decode(chunk.payload));
        }
        decoder.dispose();
        const bytes = parts.reduce((n, p) => n + p.byteLength, 0);
        return new Response(new Blob([wavHeader(bytes) as BlobPart, ...(parts as BlobPart[])]), {
          headers: { "content-type": "audio/wav" },
        });
      }),

      // Room password

      "/api/rooms/:roomId/auth": {
        POST: withRoomPassword((_req, room) => json({ ok: true, room: publicRoom(room) })),
      },

      "/api/rooms/:roomId/segments/:segmentId": {
        GET: withRoom((req, room) => {
          const segment = rooms.getTranscript(room.id).segments[req.params.segmentId];
          return segment ? json(segment) : error(404, "No such segment");
        }),
        PATCH: withRoomPassword(async (req, room) => {
          const segment = rooms.getTranscript(room.id).segments[req.params.segmentId];
          if (!segment) return error(404, "No such segment");
          const body = (await req.json().catch(() => ({}))) as { text?: unknown; author?: unknown; revertTo?: unknown };
          let text: string;
          if (typeof body.revertTo === "number") {
            const version = segment.versions.find((v) => v.seq === body.revertTo);
            if (!version) return error(400, "No such version");
            text = version.text;
          } else if (typeof body.text === "string") {
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
