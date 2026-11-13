/**
 * Uploads one stream's chunks to the server over the ingest WebSocket
 * protocol (see src/shared/protocol.ts), from a local chunk store.
 *
 * No DOM here: the socket comes from an injected factory and the chunks from
 * a ChunkStore, so tests can drive it with a fake socket and an in-memory store.
 *
 * Lifecycle of a stream:
 *  - Live: the recorder calls `addChunk(seq, payload)` every 100 ms. Each chunk
 *    is written to the store first, then sent if a connection is up.
 *  - `finish()`: recording stopped. Once the server has acked every chunk, the
 *    uploader sends `end`, waits for a clean close, and deletes the stream
 *    from the store.
 *  - Resumed (backlog from an earlier page load): created with the stored
 *    stream marked `stopped`, so it uploads what is left and then ends.
 *
 * The connection is retried with backoff until the stream is done. On every
 * `ready {next}` the uploader resumes from `next`, so whatever was in flight
 * when a connection died is simply sent again.
 *
 * Local seq vs wire seq: chunks are stored under the recorder's seq. Normally
 * the server sees the same numbers under the same stream id. If the server
 * turns out to have lost chunks we already pruned, that stream id can never
 * be completed, so the uploader ends it and carries on under a new "wire"
 * stream id whose chunk 0 is the oldest chunk still held locally
 * (`wireBase`). Both are persisted in the stream record so a reload continues
 * the same way.
 */
import { CHUNK_MS, PCM_CHUNK_BYTES, encodeChunkFrame, type ClientMessage, type ServerMessage } from "../../shared/protocol.ts";
import type { AudioFormat } from "../../shared/transcript.ts";
import type { ChunkStore, StoredStream } from "./chunkStore.ts";

/** The subset of WebSocket the uploader needs. */
export interface UploadSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  readonly bufferedAmount: number;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  /**
   * `clean` is true for an orderly close handshake (wasClean). `reason` is the
   * close reason, or a diagnosis of why the connection never opened.
   */
  onClose(clean: boolean, reason?: string): void;
}

export type SocketFactory = (handlers: SocketHandlers) => UploadSocket;

/** Reasons after which retrying the same stream can never succeed. */
const TERMINAL_ERRORS = ["Room deleted", "No such room", "Stream belongs to another room"];
const AUTH_ERRORS = ["Wrong room password", "Room password changed"];

/** Opens a real WebSocket to `url`. */
export function webSocketFactory(url: string): SocketFactory {
  return (handlers) => {
    const ws = new WebSocket(url);
    let opened = false;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      opened = true;
      handlers.onOpen();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") handlers.onMessage(e.data);
    };
    ws.onclose = (e) => {
      if (opened) return handlers.onClose(e.wasClean, e.reason || undefined);
      // A browser hides why an upgrade failed. Ask over plain HTTP, where the
      // ingest route answers 404 for a room that doesn't exist (any other
      // answer, or no answer, means "try again later").
      const http = new URL(url);
      http.protocol = http.protocol === "wss:" ? "https:" : "http:";
      fetch(http)
        .then((res) => handlers.onClose(false, res.status === 404 ? "No such room" : undefined))
        .catch(() => handlers.onClose(false));
    };
    return {
      send: (data) => ws.send(data as string | Uint8Array<ArrayBuffer>),
      close: () => ws.close(),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
  };
}

/**
 * - `unauthorized`: the room password was rejected; waiting for `setPassword`.
 * - `gone`: the room no longer exists; the backlog is kept until `discard()`.
 */
export type ConnectionState = "connecting" | "connected" | "backoff" | "unauthorized" | "gone" | "done";

export interface UploaderStatus {
  /** Local id: the key of this stream's chunks in the store. */
  streamId: string;
  /** The stream id the server knows this audio by (differs after a rollover). */
  wireStreamId: string;
  state: ConnectionState;
  /** Chunks recorded so far (= next local seq). */
  recorded: number;
  /** Server has every chunk below this (local seq). */
  acked: number;
  backlogChunks: number;
  backlogBytes: number;
  stopped: boolean;
  lastError: string | null;
  /** Set when chunks could not be written to local storage (they are held in memory instead). */
  storageError: string | null;
  /** Something the crew should know that doesn't stop the upload (audio lost, stream rolled over). */
  notice: string | null;
}

export interface UploaderOptions {
  store: ChunkStore;
  stream: StoredStream;
  connect: SocketFactory;
  password: string;
  /**
   * Monotonic ms since local chunk 0 of this stream began, for answering
   * clock-sync pings. Null when unknown (a stream resumed from an earlier page
   * load, whose start is not on this page's performance.now() clock): pings go
   * unanswered.
   */
  elapsed: (() => number) | null;
  /** Unacked chunks allowed in flight. */
  window?: number;
  /** Don't queue more while the socket's send buffer holds this many bytes. */
  maxBufferedBytes?: number;
  backoff?: { initialMs: number; maxMs: number };
  /** Reconnect when the server says nothing for this long (it pings every few seconds). */
  silenceTimeoutMs?: number;
  /** Delay before retrying a failed local write once. */
  writeRetryMs?: number;
  /** New stream ids, for rollovers. */
  newStreamId?: () => string;
  onChange?: () => void;
}

/** A stand-in for a chunk that was never stored: 100 ms of silence. */
export function silentChunk(format: AudioFormat): Uint8Array {
  // An Opus chunk with no packets decodes as 100 ms of silence on the server.
  return format === "opus" ? new Uint8Array(0) : new Uint8Array(PCM_CHUNK_BYTES);
}

export function randomStreamId() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

type Defaults = "window" | "maxBufferedBytes" | "backoff" | "silenceTimeoutMs" | "writeRetryMs" | "newStreamId";

export class StreamUploader {
  readonly streamId: string;
  private readonly opts: UploaderOptions & Required<Pick<UploaderOptions, Defaults>>;
  private stream: StoredStream;
  private password: string;

  private state: ConnectionState = "backoff";
  private socket: UploadSocket | null = null;
  /** Bumped per connection so callbacks from a dead socket are ignored. */
  private generation = 0;
  private ready = false;
  private recorded = 0;
  private acked = 0;
  /**
   * Everything below this was acked at some point and pruned locally. If the
   * server later asks for a chunk below it, the server lost data.
   */
  private prunedBelow = 0;
  /** Next local seq to send on the current connection. */
  private sendNext = 0;
  /** Chunks whose local write failed; held here until acked. */
  private memory = new Map<number, Uint8Array>();
  private backlogChunks = 0;
  private backlogBytes = 0;
  private lastError: string | null = null;
  private storageError: string | null = null;
  private notice: string | null = null;
  private endSent = false;
  private disposed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private pumpAgain = false;
  private pruning: Promise<void> = Promise.resolve();
  /** Serializes store writes so chunks become visible to the sender in seq order. */
  private writes: Promise<void> = Promise.resolve();
  private finished: Promise<void>;
  private resolveFinished!: () => void;

  private constructor(options: UploaderOptions) {
    this.opts = {
      window: 300,
      maxBufferedBytes: 256 * 1024,
      backoff: { initialMs: 500, maxMs: 10_000 },
      silenceTimeoutMs: 15_000,
      writeRetryMs: 200,
      newStreamId: randomStreamId,
      ...options,
    };
    this.stream = { ...options.stream };
    this.streamId = options.stream.id;
    this.password = options.password;
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
  }

  /**
   * Creates an uploader and starts connecting. For a stream already in the
   * store, the backlog found there is picked up.
   */
  static async start(options: UploaderOptions): Promise<StreamUploader> {
    const uploader = new StreamUploader(options);
    await uploader.init();
    return uploader;
  }

  private async init() {
    const { store } = this.opts;
    await store.putStream(this.stream);
    const stats = await store.stats(this.streamId);
    this.backlogChunks = stats.chunks;
    this.backlogBytes = stats.bytes;
    if (stats.last !== null) this.recorded = stats.last + 1;
    // Whatever is no longer stored was acked in an earlier session.
    this.acked = this.prunedBelow = stats.first ?? this.recorded;
    this.connect();
  }

  private get wireId() {
    return this.stream.wireId ?? this.stream.id;
  }

  private get wireBase() {
    return this.stream.wireBase ?? 0;
  }

  status(): UploaderStatus {
    return {
      streamId: this.streamId,
      wireStreamId: this.wireId,
      state: this.state,
      recorded: this.recorded,
      acked: this.acked,
      backlogChunks: this.backlogChunks,
      backlogBytes: this.backlogBytes,
      stopped: this.stream.stopped,
      lastError: this.lastError,
      storageError: this.storageError,
      notice: this.notice,
    };
  }

  /**
   * Stores chunk `seq` (the recorder's numbering), then sends it when
   * possible. If the local write fails even after a retry, the chunk is kept
   * in memory instead and `storageError` is set: the chunk still goes out
   * under its own seq, so later audio never shifts earlier in time.
   */
  addChunk(seq: number, payload: Uint8Array): Promise<void> {
    if (this.stream.stopped) return Promise.reject(new Error("Stream already stopped"));
    const write = this.writes.then(async () => {
      if (seq < this.recorded) throw new Error(`Chunk ${seq} added out of order (expected ${this.recorded})`);
      // A seq the recorder skipped would leave a hole the server rejects; fill it with silence.
      for (let s = this.recorded; s < seq; s++) this.hold(s, silentChunk(this.stream.format));
      try {
        await this.store(seq, payload);
      } catch (error) {
        this.storageError = `Could not save audio locally (${(error as Error).message}); holding it in memory until sent.`;
        this.hold(seq, payload.slice());
      }
      this.recorded = seq + 1;
      this.changed();
      this.pump();
    });
    // Keep the chain going even if one write fails; the caller sees the error.
    this.writes = write.catch(() => {});
    return write;
  }

  private async store(seq: number, payload: Uint8Array) {
    try {
      await this.opts.store.putChunk(this.streamId, { seq, payload });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, this.opts.writeRetryMs));
      await this.opts.store.putChunk(this.streamId, { seq, payload });
    }
    this.storageError = null;
    this.backlogChunks++;
    this.backlogBytes += payload.byteLength;
  }

  private hold(seq: number, payload: Uint8Array) {
    this.memory.set(seq, payload);
    this.backlogChunks++;
    this.backlogBytes += payload.byteLength;
  }

  /** No more chunks will come. Resolves when the server has everything and the stream is ended. */
  async finish(): Promise<void> {
    await this.writes;
    if (!this.stream.stopped) {
      this.stream.stopped = true;
      await this.opts.store.putStream(this.stream);
    }
    this.changed();
    this.pump();
    return this.finished;
  }

  /** Waits until the stream has been ended on the server and removed locally. */
  whenDone(): Promise<void> {
    return this.finished;
  }

  /** Uses a new room password from now on, and reconnects right away if the old one was refused. */
  setPassword(password: string) {
    this.password = password;
    if (this.state === "unauthorized" || this.state === "backoff") {
      this.attempt = 0;
      this.clearTimers();
      this.connect();
    }
  }

  /** Gives up on the stream and deletes its local backlog. For a stream whose room is gone. */
  async discard() {
    this.dispose();
    this.state = "done";
    this.memory.clear();
    await this.writes;
    await this.opts.store.deleteStream(this.streamId);
    this.backlogChunks = this.backlogBytes = 0;
    this.changed();
    this.resolveFinished();
  }

  /** Stops uploading (e.g. page teardown in tests) without ending the stream; the backlog stays stored. */
  dispose() {
    this.disposed = true;
    this.clearTimers();
    this.generation++;
    this.socket?.close();
    this.socket = null;
  }

  private changed() {
    this.opts.onChange?.();
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.retryTimer = this.silenceTimer = null;
  }

  private connect() {
    if (this.disposed || this.state === "done" || this.state === "gone") return;
    const generation = ++this.generation;
    this.state = "connecting";
    this.ready = false;
    this.endSent = false;
    this.changed();
    const live = () => generation === this.generation;
    this.socket = this.opts.connect({
      onOpen: () => {
        if (!live()) return;
        this.send({ type: "hello", password: this.password, streamId: this.wireId, format: this.stream.format });
      },
      onMessage: (data) => {
        if (!live()) return;
        this.armSilenceTimer();
        let message: ServerMessage;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        this.handle(message);
      },
      onClose: (clean, reason) => {
        if (!live()) return;
        this.socket = null;
        if (this.endSent && clean) return void this.complete();
        if (reason) this.noteError(reason);
        this.scheduleReconnect();
      },
    });
    this.armSilenceTimer();
  }

  private noteError(message: string) {
    this.lastError = message;
    if (TERMINAL_ERRORS.includes(message)) this.state = "gone";
    else if (AUTH_ERRORS.includes(message)) this.state = "unauthorized";
    this.changed();
  }

  private armSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    // A half-open connection (common on flaky Wi-Fi) never fires close on its
    // own; the server's regular pings tell us it is still there.
    this.silenceTimer = setTimeout(() => {
      this.lastError = "Server went silent";
      this.dropConnection();
    }, this.opts.silenceTimeoutMs);
  }

  private dropConnection() {
    this.generation++;
    this.socket?.close();
    this.socket = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.disposed || this.state === "done") return;
    this.clearTimers();
    this.ready = false;
    // These wait for the user (a new password, or discarding the backlog) instead of retrying.
    if (this.state === "gone" || this.state === "unauthorized") return void this.changed();
    this.state = "backoff";
    const { initialMs, maxMs } = this.opts.backoff;
    const delay = Math.min(maxMs, initialMs * 2 ** this.attempt++);
    // Jitter so that many senders don't all reconnect at the same instant after a redeploy.
    this.retryTimer = setTimeout(() => this.connect(), delay * (0.75 + Math.random() * 0.5));
    this.changed();
  }

  private send(message: ClientMessage) {
    this.socket?.send(JSON.stringify(message));
  }

  private handle(message: ServerMessage) {
    switch (message.type) {
      case "ready": {
        const next = message.next + this.wireBase;
        this.ready = true;
        this.attempt = 0;
        this.lastError = null;
        this.state = "connected";
        // `acked` follows the server, even backwards: it is what the server has now.
        if (next < this.acked) this.acked = next;
        this.onAcked(next);
        this.sendNext = next;
        // A resumed stream may know less than the server (its chunks were all acked and pruned).
        if (this.stream.stopped && this.recorded < next) this.recorded = next;
        this.changed();
        this.pump();
        break;
      }
      case "ack":
        this.onAcked(message.next + this.wireBase);
        this.changed();
        this.pump();
        break;
      case "ping":
        if (this.opts.elapsed) {
          // Elapsed time is measured from the wire stream's chunk 0.
          this.send({ type: "pong", id: message.id, elapsed: this.opts.elapsed() - this.wireBase * CHUNK_MS });
        }
        break;
      case "error":
        // The server closes the connection right after; reconnecting handles it.
        this.noteError(message.message);
        break;
    }
  }

  private onAcked(next: number) {
    if (next <= this.acked) return;
    this.acked = next;
    this.prunedBelow = Math.max(this.prunedBelow, next);
    for (const seq of this.memory.keys()) {
      if (seq < next) {
        this.backlogChunks--;
        this.backlogBytes -= this.memory.get(seq)!.byteLength;
        this.memory.delete(seq);
      }
    }
    // Prune in the background, one delete at a time; each covers everything acked so far.
    this.pruning = this.pruning
      .then(async () => {
        const removed = await this.opts.store.deleteChunksBelow(this.streamId, this.acked);
        this.backlogChunks -= removed.chunks;
        this.backlogBytes -= removed.bytes;
        this.changed();
      })
      .catch((error) => {
        this.lastError = `Could not prune local chunks: ${(error as Error).message}`;
      });
  }

  /** Sends stored chunks from `sendNext`, within the flow-control window. */
  private async pump() {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pumpOnce();
      } while (this.pumpAgain);
    } catch (error) {
      this.lastError = (error as Error).message;
      this.changed();
    } finally {
      this.pumping = false;
    }
  }

  private async pumpOnce() {
    for (;;) {
      if (!this.ready || !this.socket) return;
      const socket = this.socket;
      const generation = this.generation;
      if (this.sendNext >= this.recorded) {
        if (this.stream.stopped && this.acked >= this.recorded && !this.endSent) {
          this.endSent = true;
          this.send({ type: "end" });
          // Closing after `end` and waiting for a clean close confirms the
          // server got it (frames are processed in order), so it's safe to forget the stream.
          socket.close();
        }
        return;
      }
      const room = Math.min(this.acked + this.opts.window - this.sendNext, 50, this.recorded - this.sendNext);
      if (room <= 0 || socket.bufferedAmount > this.opts.maxBufferedBytes) return;
      // The first `room` stored chunks from sendNext cover every stored seq in [sendNext, sendNext + room).
      const stored = await this.opts.store.getChunks(this.streamId, this.sendNext, room);
      if (generation !== this.generation || !this.ready) return;
      const bySeq = new Map(stored.map((c) => [c.seq, c.payload]));
      const end = this.sendNext + room;
      for (let seq = this.sendNext; seq < end; seq++) {
        let payload = this.memory.get(seq) ?? bySeq.get(seq);
        if (!payload) {
          if (seq < this.prunedBelow) return this.rollover(seq);
          // Never acked, yet not stored: its write was lost (e.g. the tab died
          // while it was held in memory). Silence keeps the timeline intact.
          this.notice = `Chunk ${seq} was lost locally and was sent as 100 ms of silence`;
          payload = silentChunk(this.stream.format);
        }
        socket.send(encodeChunkFrame(seq - this.wireBase, payload));
        this.sendNext = seq + 1;
      }
    }
  }

  /**
   * The server is missing chunks we pruned after it acked them (it lost
   * data). That stream id can't be completed, so end it there and continue
   * under a new id from the oldest chunk we still have.
   */
  private async rollover(missingSeq: number) {
    const stored = await this.opts.store.getChunks(this.streamId, missingSeq, 1);
    const firstHeld = Math.min(stored[0]?.seq ?? this.recorded, ...this.memory.keys(), this.recorded);
    const lostMs = (firstHeld - missingSeq) * CHUNK_MS;
    this.send({ type: "end" });
    this.stream = { ...this.stream, wireId: this.opts.newStreamId(), wireBase: firstHeld };
    await this.opts.store.putStream(this.stream);
    this.acked = this.prunedBelow = firstHeld;
    this.notice = `The server lost ${lostMs} ms of audio it had acknowledged; continuing as stream ${this.stream.wireId}`;
    // Reconnect at once under the new id.
    this.generation++;
    this.socket?.close();
    this.socket = null;
    this.clearTimers();
    this.connect();
  }

  private async complete() {
    this.state = "done";
    this.clearTimers();
    await this.pruning;
    await this.opts.store.deleteStream(this.streamId);
    this.backlogChunks = 0;
    this.backlogBytes = 0;
    this.changed();
    this.resolveFinished();
  }
}

/** Fraction of the storage quota in use, and a warning once it passes `threshold`. */
export function storageWarning(
  estimate: { usage?: number; quota?: number } | null,
  threshold = 0.8,
): { ratio: number; message: string } | null {
  if (!estimate?.quota || estimate.usage === undefined) return null;
  const ratio = estimate.usage / estimate.quota;
  if (ratio < threshold) return null;
  return {
    ratio,
    message: `Local storage is ${Math.round(ratio * 100)}% full. The unsent backlog may soon stop being saved; restore the connection or free up disk space.`,
  };
}
