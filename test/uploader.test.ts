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
 * Plays the server's side of the ingest protocol over fake sockets. It can be
 * taken down (connections fail), drop live connections, hold chunks unacked
 * so that a drop loses them (like a crash would), change the room password,
 * and lose the room altogether.
 */
class FakeServer {
  up = true;
  password = PASSWORD;
  /** The room was deleted: connections are refused the way webSocketFactory reports a 404. */
  roomGone = false;
  /** Per stream id: chunks durably stored (`next` is their count), and whether it was ended. */
  streams = new Map<string, { stored: Uint8Array[]; ended: boolean }>();
  received: number[] = [];
  hold = false;
  pongs: { id: number; elapsed: number }[] = [];
  errors: string[] = [];
  connections = 0;
  private sockets = new Set<FakeConnection>();

  stream(id: string) {
    let stream = this.streams.get(id);
    if (!stream) this.streams.set(id, (stream = { stored: [], ended: false }));
    return stream;
  }

  /** The default test stream's chunks. */
  get stored() {
    return this.stream(DEFAULT_ID).stored;
  }
  set stored(chunks: Uint8Array[]) {
    this.stream(DEFAULT_ID).stored = chunks;
  }
  get ended() {
    return this.stream(DEFAULT_ID).ended;
  }

  factory: SocketFactory = (handlers) => {
    const conn = new FakeConnection(this, handlers);
    this.sockets.add(conn);
    this.connections++;
    setTimeout(() => {
      if (this.roomGone) conn.serverClose(false, "No such room");
      else if (this.up) handlers.onOpen();
      else conn.serverClose(false);
    }, 0);
    return conn;
  };

  /** Kills every live connection uncleanly; held (unacked) chunks are lost. */
  drop() {
    for (const conn of this.sockets) conn.serverClose(false);
  }

  /** Like ingest.disconnectRoom: an error, then the server closes. */
  disconnectAll(reason: string) {
    for (const conn of this.sockets) {
      conn.deliver({ type: "error", message: reason });
      conn.serverClose(false, reason);
    }
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
  private streamId: string | null = null;
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

  serverClose(clean: boolean, reason?: string) {
    if (!this.open) return;
    this.open = false;
    this.server.forget(this);
    setTimeout(() => this.handlers.onClose(clean, reason), 0);
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
      if (message.password !== server.password) {
        server.errors.push("Wrong room password");
        this.deliver({ type: "error", message: "Wrong room password" });
        return this.serverClose(false, "Wrong room password");
      }
      this.streamId = message.streamId;
      this.deliver({ type: "ready", next: server.stream(message.streamId).stored.length });
    } else if (message.type === "pong") {
      server.pongs.push({ id: message.id, elapsed: message.elapsed });
    } else if (message.type === "end") {
      this.flush();
      if (this.streamId) server.stream(this.streamId).ended = true;
    }
  }

  /** Stores pending chunks the way the real server does: duplicates ignored, gaps rejected. */
  flush() {
    if (!this.open || !this.streamId) return;
    const stored = this.server.stream(this.streamId).stored;
    for (const chunk of this.pending.splice(0)) {
      if (chunk.seq < stored.length) continue;
      if (chunk.seq > stored.length) {
        this.server.errors.push(`Gap at ${chunk.seq}`);
        this.deliver({ type: "error", message: "Gap" });
        return this.serverClose(false);
      }
      stored.push(chunk.payload);
    }
    this.deliver({ type: "ack", next: stored.length });
  }
}

const DEFAULT_ID = "stream-test-0001";

const uploaders: StreamUploader[] = [];
afterEach(() => {
  uploaders.splice(0).forEach((u) => u.dispose());
});

function streamRecord(overrides: Partial<StoredStream> = {}): StoredStream {
  return { id: DEFAULT_ID, roomId: "room", format: "pcm16", createdAt: 0, stopped: false, ...overrides };
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
    for (const i of range(5)) await uploader.addChunk(i, chunk(i));
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
    for (const i of range(10)) await uploader.addChunk(i, chunk(i));
    await until(() => uploader.status().backlogChunks === 0);
    expect(store.storedSeqs("stream-test-0001")).toEqual([]);
    expect(uploader.status()).toMatchObject({ recorded: 10, acked: 10, backlogBytes: 0 });
  });

  test("after a drop it reconnects and resumes from the server's next, losing nothing", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    await until(() => uploader.status().state === "connected");
    for (const i of range(3)) await uploader.addChunk(i, chunk(i));
    await until(() => uploader.status().acked === 3);

    // These reach the server but are never made durable: the drop loses them.
    server.hold = true;
    for (const i of [3, 4, 5]) await uploader.addChunk(i, chunk(i));
    await until(() => server.received.length === 6);
    server.up = false;
    server.drop();
    // Recording carries on while offline.
    for (const i of [6, 7]) await uploader.addChunk(i, chunk(i));
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
    for (const i of range(6)) await uploader.addChunk(i, chunk(i));
    server.up = true;
    await until(() => uploader.status().acked === 6);
    expect(server.received).toEqual([4, 5]);
    expect(uploader.status().backlogChunks).toBe(0);
  });

  test("finishing sends end once everything is acked, then forgets the stream", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    for (const i of range(4)) await uploader.addChunk(i, chunk(i));
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
    for (const i of range(3)) await first.addChunk(i, chunk(i));
    await until(() => first.status().acked === 3);
    server.up = false;
    server.drop();
    for (const i of [3, 4, 5, 6]) await first.addChunk(i, chunk(i));
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
    await uploader.addChunk(0, chunk(0));
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

  test("a wrong password waits for a new one instead of hammering the server", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory, password: "nope" });
    await until(() => uploader.status().state === "unauthorized");
    await uploader.addChunk(0, chunk(0));
    await Bun.sleep(50);
    expect(server.connections).toBe(1);
    expect(uploader.status().lastError).toBe("Wrong room password");
    uploader.setPassword(PASSWORD);
    await until(() => uploader.status().acked === 1);
  });

  test("a rotated room password keeps recording and resumes with the new one", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory });
    await until(() => uploader.status().state === "connected");
    await uploader.addChunk(0, chunk(0));
    await until(() => uploader.status().acked === 1);
    server.password = "rotated";
    server.disconnectAll("Room password changed");
    await until(() => uploader.status().state === "unauthorized");
    for (const i of [1, 2, 3]) await uploader.addChunk(i, chunk(i));
    expect(store.storedSeqs(DEFAULT_ID)).toEqual([1, 2, 3]);
    uploader.setPassword("rotated");
    await until(() => uploader.status().acked === 4);
    expect(storedValues(server)).toEqual(range(4));
  });

  test("a deleted room stops retrying and keeps the backlog until it is discarded", async () => {
    const server = new FakeServer();
    server.roomGone = true;
    const store = new MemoryChunkStore();
    const uploader = await startUploader({ store, connect: server.factory, stream: streamRecord({ stopped: false }) });
    await uploader.addChunk(0, chunk(0));
    await until(() => uploader.status().state === "gone");
    await Bun.sleep(50);
    expect(server.connections).toBe(1);
    expect(uploader.status().lastError).toBe("No such room");
    expect(await store.listStreams()).toHaveLength(1);
    await uploader.discard();
    expect(await store.listStreams()).toEqual([]);
    expect(store.storedSeqs(DEFAULT_ID)).toEqual([]);
  });

  test("a room deleted while connected is terminal too", async () => {
    const server = new FakeServer();
    const uploader = await startUploader({ store: new MemoryChunkStore(), connect: server.factory });
    await until(() => uploader.status().state === "connected");
    server.disconnectAll("Room deleted");
    await until(() => uploader.status().state === "gone");
    await Bun.sleep(50);
    expect(server.connections).toBe(1);
  });

  test("flow control keeps at most `window` chunks unacked", async () => {
    const server = new FakeServer();
    server.hold = true;
    const uploader = await startUploader({ store: new MemoryChunkStore(), connect: server.factory, window: 4 });
    await until(() => uploader.status().state === "connected");
    for (const i of range(10)) await uploader.addChunk(i, chunk(i));
    await Bun.sleep(20);
    expect(server.received).toEqual(range(4));
  });

  test("a failed local write keeps chunk numbering: the chunk is held in memory and still sent", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    let failures = 0;
    const put = store.putChunk.bind(store);
    store.putChunk = async (id, c) => {
      if (failures > 0) {
        failures--;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return put(id, c);
    };
    const uploader = await startUploader({ store, connect: server.factory, writeRetryMs: 1 });
    await uploader.addChunk(0, chunk(0));
    failures = 2; // the write and its retry
    await uploader.addChunk(1, chunk(1));
    expect(uploader.status().storageError).toContain("quota");
    await uploader.addChunk(2, chunk(2));
    await uploader.addChunk(3, chunk(3));
    await until(() => uploader.status().acked === 4);
    expect(storedValues(server)).toEqual([0, 1, 2, 3]);
    expect(uploader.status()).toMatchObject({ backlogChunks: 0, backlogBytes: 0 });
  });

  test("a write that succeeds on retry is not an error", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    let failures = 1;
    const put = store.putChunk.bind(store);
    store.putChunk = async (id, c) => {
      if (failures-- > 0) throw new Error("transient");
      return put(id, c);
    };
    const uploader = await startUploader({ store, connect: server.factory, writeRetryMs: 1 });
    await uploader.addChunk(0, chunk(0));
    expect(uploader.status().storageError).toBeNull();
    expect(store.storedSeqs(DEFAULT_ID)).toEqual([0]);
  });

  test("after a reload, a chunk lost from memory is sent as silence so later chunks keep their place", async () => {
    const server = new FakeServer();
    server.up = false;
    const store = new MemoryChunkStore();
    // Chunk 1 never made it to the store (it was only in the crashed tab's memory).
    await store.putStream(streamRecord());
    for (const i of [0, 2, 3]) await store.putChunk(DEFAULT_ID, { seq: i, payload: new Uint8Array(PCM_CHUNK_BYTES).fill(i + 1) });
    server.up = true;
    const resumed = await startUploader({ store, connect: server.factory, stream: streamRecord({ stopped: true }) });
    await resumed.finish();
    expect(server.stored.map((p) => p[0])).toEqual([1, 0, 3, 4]);
    expect(server.stored[1]!.byteLength).toBe(PCM_CHUNK_BYTES);
    expect(resumed.status().notice).toContain("silence");
  });

  test("recorder seqs are used as given: a skipped seq is filled with silence, not shifted", async () => {
    const server = new FakeServer();
    const uploader = await startUploader({
      store: new MemoryChunkStore(),
      connect: server.factory,
      stream: streamRecord({ format: "opus" }),
    });
    await uploader.addChunk(0, chunk(0));
    await uploader.addChunk(2, chunk(2));
    await until(() => uploader.status().acked === 3);
    expect(server.stored.map((p) => [...p])).toEqual([[0, 0, 0], [], [2, 2, 2]]);
  });

  test("when the server lost acked chunks, the stream is ended and the rest continues as a new stream", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    let ids = 0;
    const uploader = await startUploader({
      store,
      connect: server.factory,
      elapsed: () => 5000,
      newStreamId: () => `stream-rolled-${++ids}`,
    });
    for (const i of range(10)) await uploader.addChunk(i, chunk(i));
    await until(() => uploader.status().acked === 10 && uploader.status().backlogChunks === 0);
    // The server loses its last 3 chunks (say, restored from an older backup) and the connection drops.
    server.up = false;
    server.drop();
    server.stored = server.stored.slice(0, 7);
    for (const i of range(5)) await uploader.addChunk(10 + i, chunk(10 + i));
    server.up = true;
    await until(() => uploader.status().wireStreamId === "stream-rolled-1" && uploader.status().acked === 15);
    expect(server.ended).toBe(true);
    // Chunk 10 (the oldest still held) is chunk 0 of the new stream.
    expect(server.stream("stream-rolled-1").stored.map((p) => p[0])).toEqual([10, 11, 12, 13, 14]);
    expect(uploader.status().notice).toContain("lost 300 ms");
    expect(uploader.status().state).toBe("connected");
    // Live audio keeps flowing to the new stream, and pongs are relative to its chunk 0.
    await uploader.addChunk(15, chunk(15));
    await until(() => uploader.status().acked === 16);
    expect(server.stream("stream-rolled-1").stored).toHaveLength(6);
    server.ping(1);
    await until(() => server.pongs.length > 0);
    expect(server.pongs[0]!.elapsed).toBe(5000 - 10 * 100);
    // A reload carries on with the same mapping.
    uploader.dispose();
    const [record] = await store.listStreams();
    expect(record).toMatchObject({ wireId: "stream-rolled-1", wireBase: 10 });
  });

  test("acked follows the server's next downwards, and chunks still held are simply resent", async () => {
    const server = new FakeServer();
    const store = new MemoryChunkStore();
    // Pruning is slow: acked chunks are still in the store when the server loses them.
    store.deleteChunksBelow = async () => ({ chunks: 0, bytes: 0 });
    const seen: number[] = [];
    let uploader: StreamUploader | null = null;
    uploader = await startUploader({
      store,
      connect: server.factory,
      onChange: () => uploader && seen.push(uploader.status().acked),
    });
    for (const i of range(4)) await uploader.addChunk(i, chunk(i));
    await until(() => uploader.status().acked === 4);
    server.up = false;
    server.drop();
    server.stored = server.stored.slice(0, 2);
    server.up = true;
    await until(() => server.stored.length === 4);
    expect(seen.slice(seen.indexOf(4))).toContain(2);
    expect(storedValues(server)).toEqual(range(4));
    expect(uploader.status().wireStreamId).toBe(DEFAULT_ID);
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
    for (const i of range(10)) await uploader.addChunk(i, pcmChunk(1000 + i));
    await until(() => uploader.status().acked === 10);

    await server.restart();
    for (const i of range(10)) await uploader.addChunk(10 + i, pcmChunk(2000 + i));
    await uploader.finish();

    const [listed] = await server.json("/api/admin/rooms", { auth: MASTER });
    expect(listed.streams).toEqual([
      expect.objectContaining({ id: "stream-real-0001", format: "pcm16", durationMs: 2000, ended: true }),
    ]);
    expect(await store.listStreams()).toEqual([]);
  });
});
