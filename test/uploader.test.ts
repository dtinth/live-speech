import { afterEach, describe, expect, test } from "bun:test";
import {
  PCM_CHUNK_BYTES,
  decodeChunkFrame,
  unpackOpusPackets,
  type ClientMessage,
  type ServerMessage,
} from "../src/shared/protocol.ts";
import { MemoryChunkStore, type StoredStream } from "../src/web/sender/chunkStore.ts";
import { OpusChunker, Pcm16Chunker } from "../src/web/sender/chunking.ts";
import {
  StreamUploader,
  storageWarning,
  webSocketFactory,
  type SocketFactory,
  type SocketHandlers,
  type UploaderOptions,
} from "../src/web/sender/uploader.ts";
import { MASTER, TestServer, pcmChunk } from "./harness.ts";

const PASSWORD = "room-password";

/**
 * Plays the server's side of the ingest protocol for one stream, over fake
 * sockets. It can be taken down (connections fail), drop live connections,
 * and hold chunks unacked so that a drop loses them, like a crash would.
 */
class FakeServer {
  up = true;
  /** Chunks durably stored: the `next` a fresh connection is told. */
  stored: Uint8Array[] = [];
  received: number[] = [];
  ended = false;
  hold = false;
  pongs: { id: number; elapsed: number }[] = [];
  errors: string[] = [];
  connections = 0;
  private sockets = new Set<FakeConnection>();

  factory: SocketFactory = (handlers) => {
    const conn = new FakeConnection(this, handlers);
    this.sockets.add(conn);
    this.connections++;
    setTimeout(() => (this.up ? handlers.onOpen() : conn.serverClose(false)), 0);
    return conn;
  };

  /** Kills every live connection uncleanly; held (unacked) chunks are lost. */
  drop() {
    for (const conn of this.sockets) conn.serverClose(false);
  }

  forget(conn: FakeConnection) {
    this.sockets.delete(conn);
  }

  ping(id: number) {
    for (const conn of this.sockets) conn.deliver({ type: "ping", id });
  }
}

class FakeConnection {
  bufferedAmount = 0;
  private open = true;
  private hello = false;
  private pending: { seq: number; payload: Uint8Array }[] = [];

  constructor(
    private server: FakeServer,
    private handlers: SocketHandlers,
  ) {}

  deliver(message: ServerMessage) {
    if (!this.open) return;
    // Already on the wire: it arrives even if the server closes right after (as with error).
    setTimeout(() => this.handlers.onMessage(JSON.stringify(message)), 0);
  }

  serverClose(clean: boolean) {
    if (!this.open) return;
    this.open = false;
    this.server.forget(this);
    setTimeout(() => this.handlers.onClose(clean), 0);
  }

  close() {
    // The client closing: an orderly handshake once everything sent has been read.
    this.serverClose(true);
  }

  send(data: string | Uint8Array) {
    if (!this.open) return;
    const server = this.server;
    if (typeof data !== "string") {
      const chunk = decodeChunkFrame(data);
      server.received.push(chunk.seq);
      this.pending.push({ seq: chunk.seq, payload: chunk.payload.slice() });
      if (!server.hold) setTimeout(() => this.flush(), 0);
      return;
    }
    const message = JSON.parse(data) as ClientMessage;
    if (message.type === "hello") {
      if (message.password !== PASSWORD) {
        server.errors.push("Wrong room password");
        this.deliver({ type: "error", message: "Wrong room password" });
        return this.serverClose(false);
      }
      this.hello = true;
      this.deliver({ type: "ready", next: server.stored.length });
    } else if (message.type === "pong") {
      server.pongs.push({ id: message.id, elapsed: message.elapsed });
    } else if (message.type === "end") {
      this.flush();
      server.ended = true;
    }
  }

  /** Stores pending chunks the way the real server does: duplicates ignored, gaps rejected. */
  flush() {
    if (!this.open || !this.hello) return;
    const server = this.server;
    for (const chunk of this.pending.splice(0)) {
      if (chunk.seq < server.stored.length) continue;
      if (chunk.seq > server.stored.length) {
        server.errors.push(`Gap at ${chunk.seq}`);
        this.deliver({ type: "error", message: "Gap" });
        return this.serverClose(false);
      }
      server.stored.push(chunk.payload);
    }
    this.deliver({ type: "ack", next: server.stored.length });
  }
}

const uploaders: StreamUploader[] = [];
afterEach(() => {
  uploaders.splice(0).forEach((u) => u.dispose());
});

function streamRecord(overrides: Partial<StoredStream> = {}): StoredStream {
  return { id: "stream-test-0001", roomId: "room", format: "pcm16", createdAt: 0, stopped: false, ...overrides };
}

async function startUploader(options: Partial<UploaderOptions> & Pick<UploaderOptions, "store" | "connect">) {
  const uploader = await StreamUploader.start({
    stream: streamRecord(),
    password: PASSWORD,
    elapsed: null,
    backoff: { initialMs: 5, maxMs: 20 },
    ...options,
  });
  uploaders.push(uploader);
  return uploader;
}

async function until(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(2);
  }
}

const chunk = (n: number) => new Uint8Array([n, n, n]);
const storedValues = (server: FakeServer) => server.stored.map((p) => p[0]);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("uploader", () => {
  test("chunks recorded before the connection is up are stored, then sent once it is", async () => {
    const server = new FakeServer();
    server.up = false;
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    for (const i of range(5)) await uploader.addChunk(chunk(i));
    expect(store.storedSeqs("stream-test-0001")).toEqual(range(5));
    expect(uploader.status()).toMatchObject({ recorded: 5, acked: 0, backlogChunks: 5, backlogBytes: 15 });

    server.up = true;
    await until(() => uploader.status().acked === 5);
    expect(storedValues(server)).toEqual(range(5));
    expect(uploader.status().state).toBe("connected");
  });

  test("acknowledged chunks are pruned, so the store holds only the unsent backlog", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    await until(() => uploader.status().state === "connected");
    for (const i of range(10)) await uploader.addChunk(chunk(i));
    await until(() => uploader.status().backlogChunks === 0);
    expect(store.storedSeqs("stream-test-0001")).toEqual([]);
    expect(uploader.status()).toMatchObject({ recorded: 10, acked: 10, backlogBytes: 0 });
  });

  test("after a drop it reconnects and resumes from the server's next, losing nothing", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    await until(() => uploader.status().state === "connected");
    for (const i of range(3)) await uploader.addChunk(chunk(i));
    await until(() => uploader.status().acked === 3);

    // These reach the server but are never made durable: the drop loses them.
    server.hold = true;
    for (const i of [3, 4, 5]) await uploader.addChunk(chunk(i));
    await until(() => server.received.length === 6);
    server.up = false;
    server.drop();
    // Recording carries on while offline.
    for (const i of [6, 7]) await uploader.addChunk(chunk(i));
    await until(() => uploader.status().state === "backoff");
    expect(store.storedSeqs("stream-test-0001")).toEqual([3, 4, 5, 6, 7]);

    server.hold = false;
    server.up = true;
    await until(() => uploader.status().acked === 8);
    expect(storedValues(server)).toEqual(range(8));
    expect(server.errors).toEqual([]);
    expect(server.connections).toBeGreaterThan(1);
    expect(store.storedSeqs("stream-test-0001")).toEqual([]);
  });

  test("on ready it drops local chunks the server already has, and doesn't resend them", async () => {
    const server = new FakeServer();
    server.up = false;
    // The server stored 0–3, but the acks never arrived before the connection died.
    server.stored = range(4).map(chunk);
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    for (const i of range(6)) await uploader.addChunk(chunk(i));
    server.up = true;
    await until(() => uploader.status().acked === 6);
    expect(server.received).toEqual([4, 5]);
    expect(uploader.status().backlogChunks).toBe(0);
  });

  test("finishing sends end once everything is acked, then forgets the stream", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    for (const i of range(4)) await uploader.addChunk(chunk(i));
    await uploader.finish();
    expect(server.ended).toBe(true);
    expect(storedValues(server)).toEqual(range(4));
    expect(await store.listStreams()).toEqual([]);
    expect(uploader.status().state).toBe("done");
  });

  test("a reload resumes the leftover backlog with the same stream id, then ends the stream", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const first = await startUploader({ store, connect: server.factory });
    await until(() => first.status().state === "connected");
    for (const i of range(3)) await first.addChunk(chunk(i));
    await until(() => first.status().acked === 3);
    server.up = false;
    server.drop();
    for (const i of [3, 4, 5, 6]) await first.addChunk(chunk(i));
    // The tab crashes: the uploader just stops, its backlog is left in the store.
    first.dispose();

    const [left] = await store.listStreams();
    expect(left).toMatchObject({ id: "stream-test-0001", format: "pcm16", stopped: false });
    expect(store.storedSeqs(left!.id)).toEqual([3, 4, 5, 6]);

    // The page is opened again.
    server.up = true;
    const resumed = await startUploader({ store, connect: server.factory, stream: { ...left!, stopped: true } });
    expect(resumed.status()).toMatchObject({ recorded: 7, acked: 3, backlogChunks: 4 });
    await resumed.finish();
    expect(storedValues(server)).toEqual(range(7));
    expect(server.ended).toBe(true);
    expect(await store.listStreams()).toEqual([]);
  });

  test("a resumed stream whose chunks were all acked still gets ended", async () => {
    const server = new FakeServer();
    server.stored = range(5).map(chunk);
    const store = new MemoryChunkStore();
    await store.putStream(streamRecord());
    const resumed = await startUploader({ store, connect: server.factory, stream: streamRecord({ stopped: true }) });
    await resumed.finish();
    expect(server.ended).toBe(true);
    expect(server.received).toEqual([]);
  });

  test("end is resent if the connection dies before the close handshake", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    await uploader.addChunk(chunk(0));
    await until(() => uploader.status().acked === 1);
    server.up = false;
    server.drop();
    const finished = uploader.finish();
    await Bun.sleep(30);
    expect(server.ended).toBe(false);
    expect(await store.listStreams()).toHaveLength(1);
    server.up = true;
    await finished;
    expect(server.ended).toBe(true);
  });

  test("pings are answered for a live stream, and ignored for a resumed one", async () => {
    const server = new FakeServer();
    const live = await startUploader({ store: new MemoryChunkStore(), connect: server.factory, elapsed: () => 1234 });
    await until(() => live.status().state === "connected");
    server.ping(7);
    await until(() => server.pongs.length === 1);
    expect(server.pongs).toEqual([{ id: 7, elapsed: 1234 }]);
    live.dispose();

    const other = new FakeServer();
    const resumed = await startUploader({
      store: new MemoryChunkStore(),
      connect: other.factory,
      stream: streamRecord({ stopped: true }),
    });
    await until(() => resumed.status().state !== "connecting");
    other.ping(1);
    await Bun.sleep(20);
    expect(other.pongs).toEqual([]);
  });

  test("a server that goes silent is treated as a dead connection", async () => {
    const server = new FakeServer();
    const uploader = await startUploader({ store: new MemoryChunkStore(), connect: server.factory, silenceTimeoutMs: 30 });
    await until(() => uploader.status().state === "connected");
    await until(() => server.connections > 1);
    expect(uploader.status().lastError).toBe("Server went silent");
  });

  test("a wrong password is reported and retried", async () => {
    const server = new FakeServer();
    const uploader = await startUploader({ store: new MemoryChunkStore(), connect: server.factory, password: "nope" });
    await until(() => server.connections > 1);
    expect(uploader.status().lastError).toBe("Wrong room password");
    expect(uploader.status().state).not.toBe("connected");
  });

  test("flow control keeps at most `window` chunks unacked", async () => {
    const server = new FakeServer();
    server.hold = true;
    const uploader = await startUploader({ store: new MemoryChunkStore(), connect: server.factory, window: 4 });
    await until(() => uploader.status().state === "connected");
    for (const i of range(10)) await uploader.addChunk(chunk(i));
    await Bun.sleep(20);
    expect(server.received).toEqual(range(4));
  });
});

describe("storage warning", () => {
  test("warns only past the threshold, and only with a known quota", () => {
    expect(storageWarning(null)).toBeNull();
    expect(storageWarning({ usage: 10 })).toBeNull();
    expect(storageWarning({ usage: 79, quota: 100 })).toBeNull();
    expect(storageWarning({ usage: 85, quota: 100 })).toMatchObject({ ratio: 0.85 });
    expect(storageWarning({ usage: 85, quota: 100 })!.message).toContain("85%");
    expect(storageWarning({ usage: 50, quota: 100 }, 0.5)).not.toBeNull();
  });
});

describe("chunking", () => {
  test("Opus packets are grouped into 100 ms chunks by timestamp", () => {
    const chunks: { seq: number; packets: number[] }[] = [];
    const chunker = new OpusChunker((seq, payload) =>
      chunks.push({ seq, packets: unpackOpusPackets(payload).map((p) => p[0]!) }),
    );
    // 20 ms packets, the first 12 of a stream: 0–4 → chunk 0, 5–9 → chunk 1, 10–11 → chunk 2.
    for (const i of range(12)) chunker.push(i * 20_000, new Uint8Array([i, 0xaa]));
    expect(chunks).toEqual([
      { seq: 0, packets: [0, 1, 2, 3, 4] },
      { seq: 1, packets: [5, 6, 7, 8, 9] },
    ]);
    chunker.flush();
    expect(chunks[2]).toEqual({ seq: 2, packets: [10, 11] });
  });

  test("an Opus window with no packets still gets a chunk, keeping seq gap-free", () => {
    const seqs: number[] = [];
    const chunker = new OpusChunker((seq) => seqs.push(seq));
    chunker.push(0, new Uint8Array([1]));
    chunker.push(350_000, new Uint8Array([2]));
    chunker.flush();
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  test("timestamps a hair under a boundary (sample rounding) land in the right chunk", () => {
    const chunks: number[][] = [];
    const chunker = new OpusChunker((_seq, payload) => chunks.push(unpackOpusPackets(payload).map((p) => p[0]!)));
    // 44.1 kHz: 882-sample frames, timestamps rounded to whole µs.
    for (const i of range(10)) chunker.push(Math.round(((i * 882) / 44100) * 1e6) - (i === 5 ? 1 : 0), new Uint8Array([i]));
    chunker.flush();
    expect(chunks).toEqual([
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8, 9],
    ]);
  });

  for (const rate of [48000, 44100, 16000, 8000]) {
    test(`PCM at ${rate} Hz becomes exact 100 ms chunks of 16 kHz Int16`, () => {
      const chunks: Uint8Array[] = [];
      const chunker = new Pcm16Chunker(rate, (seq, payload) => {
        expect(seq).toBe(chunks.length);
        chunks.push(payload);
      });
      // One second of a constant level, fed in odd-sized blocks.
      const total = rate;
      for (let fed = 0; fed < total; ) {
        const n = Math.min(333, total - fed);
        chunker.push(new Float32Array(n).fill(0.5));
        fed += n;
      }
      chunker.flush();
      expect(chunks.length).toBe(10);
      for (const c of chunks) expect(c.byteLength).toBe(PCM_CHUNK_BYTES);
      const first = new Int16Array(chunks[0]!.buffer);
      expect(first[0]).toBe(Math.round(0.5 * 0x7fff));
      expect(first[1599]).toBe(Math.round(0.5 * 0x7fff));
    });
  }
});

describe("against the real server", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.dispose();
    server = null;
  });

  test("a stream survives a server restart mid-upload with no gap, and is ended", async () => {
    server = new TestServer();
    const room = await server.createRoom();
    const store = new MemoryChunkStore();
    const url = () => {
      const u = new URL(`/api/rooms/${room.id}/ingest`, server!.app.url);
      u.protocol = "ws:";
      return u.toString();
    };
    const began = performance.now();
    const uploader = await StreamUploader.start({
      store,
      stream: streamRecord({ id: "stream-real-0001", roomId: room.id }),
      // Resolve the URL per connection: the restarted server gets a new port.
      connect: (handlers) => webSocketFactory(url())(handlers),
      password: room.password,
      elapsed: () => performance.now() - began,
      backoff: { initialMs: 10, maxMs: 50 },
    });
    uploaders.push(uploader);
    for (const i of range(10)) await uploader.addChunk(pcmChunk(1000 + i));
    await until(() => uploader.status().acked === 10);

    await server.restart();
    for (const i of range(10)) await uploader.addChunk(pcmChunk(2000 + i));
    await uploader.finish();

    const [listed] = await server.json("/api/admin/rooms", { auth: MASTER });
    expect(listed.streams).toEqual([
      expect.objectContaining({ id: "stream-real-0001", format: "pcm16", durationMs: 2000, ended: true }),
    ]);
    expect(await store.listStreams()).toEqual([]);
  });
});
