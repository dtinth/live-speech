/**
 * Uploads one stream's chunks to the server over the ingest WebSocket
 * protocol (see src/shared/protocol.ts), from a local chunk store.
 *
 * No DOM here: the socket comes from an injected factory and the chunks from
 * a ChunkStore, so tests can drive it with a fake socket and an in-memory store.
 *
 * Lifecycle of a stream:
 *  - Live: the recorder calls `addChunk` every 100 ms. Each chunk is written to
 *    the store first, then sent if a connection is up.
 *  - `finish()`: recording stopped. Once the server has acked every chunk, the
 *    uploader sends `end`, waits for a clean close, and deletes the stream
 *    from the store.
 *  - Resumed (backlog from an earlier page load): created with the stored
 *    stream marked `stopped`, so it uploads what is left and then ends.
 *
 * The connection is retried with backoff until the stream is done. On every
 * `ready {next}` the uploader resumes from `next`, so whatever was in flight
 * when a connection died is simply sent again.
 */
import { encodeChunkFrame, type ClientMessage, type ServerMessage } from "../../shared/protocol.ts";
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
  /** `clean` is true for an orderly close handshake (wasClean). */
  onClose(clean: boolean): void;
}

export type SocketFactory = (handlers: SocketHandlers) => UploadSocket;

/** Opens a real WebSocket to `url`. */
export function webSocketFactory(url: string): SocketFactory {
  return (handlers) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (e) => {
      if (typeof e.data === "string") handlers.onMessage(e.data);
    };
    ws.onclose = (e) => handlers.onClose(e.wasClean);
    return {
      send: (data) => ws.send(data as string | Uint8Array<ArrayBuffer>),
      close: () => ws.close(),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
    };
  };
}

export type ConnectionState = "connecting" | "connected" | "backoff" | "done";

export interface UploaderStatus {
  streamId: string;
  state: ConnectionState;
  /** Chunks durably stored locally so far (= next seq to record), at least as far as we know. */
  recorded: number;
  /** Server has every chunk below this. */
  acked: number;
  backlogChunks: number;
  backlogBytes: number;
  stopped: boolean;
  lastError: string | null;
}

export interface UploaderOptions {
  store: ChunkStore;
  stream: StoredStream;
  connect: SocketFactory;
  password: string;
  /**
   * Monotonic ms since chunk 0 of this stream began, for answering clock-sync
   * pings. Null when unknown (a stream resumed from an earlier page load, whose
   * start is not on this page's performance.now() clock): pings go unanswered.
   */
  elapsed: (() => number) | null;
  /** Unacked chunks allowed in flight. */
  window?: number;
  /** Don't queue more while the socket's send buffer holds this many bytes. */
  maxBufferedBytes?: number;
  backoff?: { initialMs: number; maxMs: number };
  /** Reconnect when the server says nothing for this long (it pings every few seconds). */
  silenceTimeoutMs?: number;
  onChange?: () => void;
}

export class StreamUploader {
  readonly streamId: string;
  private readonly opts: Required<Omit<UploaderOptions, "onChange" | "elapsed">> & Pick<UploaderOptions, "onChange" | "elapsed">;
  private stream: StoredStream;

  private state: ConnectionState = "backoff";
  private socket: UploadSocket | null = null;
  /** Bumped per connection so callbacks from a dead socket are ignored. */
  private generation = 0;
  private ready = false;
  private recorded = 0;
  private acked = 0;
  /** Next seq to send on the current connection. */
  private sendNext = 0;
  private backlogChunks = 0;
  private backlogBytes = 0;
  private lastError: string | null = null;
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
      ...options,
    };
    this.stream = { ...options.stream };
    this.streamId = options.stream.id;
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
    this.acked = stats.first ?? this.recorded;
    this.connect();
  }

  status(): UploaderStatus {
    return {
      streamId: this.streamId,
      state: this.state,
      recorded: this.recorded,
      acked: this.acked,
      backlogChunks: this.backlogChunks,
      backlogBytes: this.backlogBytes,
      stopped: this.stream.stopped,
      lastError: this.lastError,
    };
  }

  /** Stores the next chunk, then sends it when possible. Resolves once it is stored. */
  addChunk(payload: Uint8Array): Promise<void> {
    if (this.stream.stopped) return Promise.reject(new Error("Stream already stopped"));
    const write = this.writes.then(async () => {
      const seq = this.recorded;
      await this.opts.store.putChunk(this.streamId, { seq, payload });
      this.recorded = seq + 1;
      this.backlogChunks++;
      this.backlogBytes += payload.byteLength;
      this.changed();
      this.pump();
    });
    // Keep the chain going even if one write fails; the caller sees the error.
    this.writes = write.catch(() => {});
    return write;
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
    if (this.disposed || this.state === "done") return;
    const generation = ++this.generation;
    this.state = "connecting";
    this.ready = false;
    this.endSent = false;
    this.changed();
    const live = () => generation === this.generation;
    this.socket = this.opts.connect({
      onOpen: () => {
        if (!live()) return;
        this.send({ type: "hello", password: this.opts.password, streamId: this.streamId, format: this.stream.format });
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
      onClose: (clean) => {
        if (!live()) return;
        this.socket = null;
        if (this.endSent && clean) return void this.complete();
        this.scheduleReconnect();
      },
    });
    this.armSilenceTimer();
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
      case "ready":
        this.ready = true;
        this.attempt = 0;
        this.lastError = null;
        this.state = "connected";
        this.onAcked(message.next);
        this.sendNext = message.next;
        // A resumed stream may know less than the server (its chunks were all acked and pruned).
        if (this.stream.stopped && this.recorded < message.next) this.recorded = message.next;
        this.changed();
        this.pump();
        break;
      case "ack":
        this.onAcked(message.next);
        this.changed();
        this.pump();
        break;
      case "ping":
        if (this.opts.elapsed) this.send({ type: "pong", id: message.id, elapsed: this.opts.elapsed() });
        break;
      case "error":
        // The server closes the connection right after; reconnecting handles it.
        this.lastError = message.message;
        this.changed();
        break;
    }
  }

  private onAcked(next: number) {
    if (next <= this.acked) return;
    this.acked = next;
    // Prune in the background, one delete at a time; each covers everything acked so far.
    this.pruning = this.pruning.then(async () => {
      const target = this.acked;
      const removed = await this.opts.store.deleteChunksBelow(this.streamId, target);
      this.backlogChunks -= removed.chunks;
      this.backlogBytes -= removed.bytes;
      this.changed();
    }).catch((error) => {
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
      const room = this.acked + this.opts.window - this.sendNext;
      if (room <= 0 || socket.bufferedAmount > this.opts.maxBufferedBytes) return;
      const chunks = await this.opts.store.getChunks(this.streamId, this.sendNext, Math.min(room, 50));
      if (generation !== this.generation || !this.ready) return;
      if (chunks.length === 0 || chunks[0]!.seq !== this.sendNext) {
        // The server needs a chunk we no longer have. Nothing we can do but say so.
        throw new Error(`Chunk ${this.sendNext} is missing locally; cannot continue this stream`);
      }
      for (const chunk of chunks) {
        if (chunk.seq !== this.sendNext) break;
        socket.send(encodeChunkFrame(chunk.seq, chunk.payload));
        this.sendNext++;
      }
    }
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
