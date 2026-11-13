import { CHUNK_MS } from "../shared/protocol.ts";
import type { AudioStore } from "./audioStore.ts";
import { createChunkDecoder, type ChunkDecoder } from "./decoder.ts";
import { randomId, type RoomService } from "./rooms.ts";
import type { TranscriptionProvider, TranscriptionSession } from "./transcription/provider.ts";

export interface TranscriberOptions {
  /**
   * How much faster than realtime stored audio may be fed when catching up.
   * Realtime vendors want ~1x; Infinity feeds everything at once (tests).
   */
  catchUpSpeed: number;
  /** Finish a vendor session after this long with no audio to feed. */
  idleMs: number;
  /** Wait this long before retrying after a session error. */
  retryMs: number;
}

/**
 * Feeds each stream's stored audio to the transcription provider, from where
 * transcription last got to, and logs the segments that come back.
 *
 * It reads from disk rather than from the live socket, so audio that arrives
 * late (after an outage) or survives a server restart is transcribed the same
 * way as live audio.
 */
export class Transcriber {
  private workers = new Map<string, StreamWorker>();
  private stopped = false;

  constructor(
    private readonly rooms: RoomService,
    private readonly audio: AudioStore,
    private readonly provider: TranscriptionProvider,
    private readonly options: TranscriberOptions,
  ) {}

  /** Resume any stream with untranscribed audio, e.g. after a restart. */
  resumeAll() {
    for (const stream of this.rooms.listStreams()) {
      if (stream.transcribedUntil < stream.chunkCount) this.notify(stream.id);
    }
  }

  /** New audio is available for this stream (or it ended). */
  notify(streamId: string) {
    if (this.stopped) return;
    let worker = this.workers.get(streamId);
    if (!worker) {
      worker = new StreamWorker(streamId, this.rooms, this.audio, this.provider, this.options, () => {
        this.workers.delete(streamId);
      });
      this.workers.set(streamId, worker);
    }
    worker.wake();
  }

  /** Resolves once every stream has been transcribed as far as its audio goes. */
  async idle() {
    while (this.workers.size > 0) await Promise.all([...this.workers.values()].map((w) => w.done));
  }

  stop() {
    this.stopped = true;
    for (const worker of this.workers.values()) worker.stop();
    this.workers.clear();
  }
}

class StreamWorker {
  private session: TranscriptionSession | null = null;
  private decoder: ChunkDecoder | null = null;
  /** Chunk seq the current session began at; provider offsets are relative to it. */
  private baseSeq = 0;
  /** Next chunk to feed, and where it starts in the stream file. */
  private nextSeq = 0;
  private nextOffset = 0;
  private sessionStartedAt = 0;
  private fedInSession = 0;
  private lastFedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private finishing = false;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((resolve) => (this.resolveDone = resolve));

  constructor(
    private readonly streamId: string,
    private readonly rooms: RoomService,
    private readonly audio: AudioStore,
    private readonly provider: TranscriptionProvider,
    private readonly options: TranscriberOptions,
    private readonly onExit: () => void,
  ) {}

  wake() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, 0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.session?.close();
    this.decoder?.dispose();
    this.resolveDone();
  }

  private exit() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.decoder?.dispose();
    this.decoder = null;
    this.onExit();
    this.resolveDone();
  }

  private schedule(ms: number) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, ms);
  }

  private tick() {
    if (this.stopped || this.finishing) return;
    const stream = this.rooms.getStream(this.streamId);
    if (!stream) return this.exit();

    if (!this.session) {
      if (stream.transcribedUntil >= stream.chunkCount) return this.exit();
      this.startSession(stream.transcribedUntil);
    }

    // Feed as much as the pacing budget allows.
    const now = performance.now();
    const budget =
      this.options.catchUpSpeed === Infinity
        ? Infinity
        : Math.floor(((now - this.sessionStartedAt) * this.options.catchUpSpeed) / CHUNK_MS) + 1 - this.fedInSession;
    let fed = 0;
    if (budget > 0 && this.nextSeq < stream.chunkCount) {
      for (const chunk of this.audio.read(stream.roomId, stream.id, stream.byteLength, {
        fromSeq: this.nextSeq,
        startOffset: this.nextOffset,
      })) {
        this.session!.sendAudio(this.decoder!.decode(chunk.payload));
        this.nextSeq = chunk.seq + 1;
        this.nextOffset = chunk.nextOffset;
        this.fedInSession++;
        if (++fed >= budget) break;
      }
    }
    if (fed > 0) this.lastFedAt = now;

    const caughtUp = this.nextSeq >= stream.chunkCount;
    if (caughtUp && (stream.ended || now - this.lastFedAt >= this.options.idleMs)) {
      this.finishSession();
      return;
    }
    if (!caughtUp) {
      this.schedule(this.options.catchUpSpeed === Infinity ? 0 : 20);
    } else {
      // Wait for more audio (notify() wakes us) or for the idle timeout.
      this.schedule(Math.max(0, this.options.idleMs - (now - this.lastFedAt)));
    }
  }

  private startSession(fromSeq: number) {
    const stream = this.rooms.getStream(this.streamId)!;
    this.baseSeq = fromSeq;
    this.nextSeq = fromSeq;
    this.nextOffset = 0; // read() skips to fromSeq on the first pass
    this.sessionStartedAt = performance.now();
    this.lastFedAt = this.sessionStartedAt;
    this.fedInSession = 0;
    this.decoder?.dispose();
    this.decoder = createChunkDecoder(stream.format);
    const base = fromSeq * CHUNK_MS;
    const roomId = stream.roomId;
    const session = this.provider.createSession({
      onPartial: (startMs, text) => {
        if (this.session !== session) return;
        this.rooms.setPartial(roomId, { streamId: this.streamId, startMs: base + startMs, text });
      },
      onSegment: (startMs, endMs, text) => {
        if (this.session !== session) return;
        this.rooms.setPartial(roomId, { streamId: this.streamId, startMs: base + startMs, text: "" }, true);
        if (text.trim()) {
          this.rooms.appendEvent(roomId, {
            type: "segment.final",
            segmentId: randomId(8),
            streamId: this.streamId,
            startMs: base + startMs,
            endMs: base + endMs,
            text: text.trim(),
            source: this.provider.name,
          });
        }
        this.rooms.setTranscribedUntil(this.streamId, Math.floor((base + endMs) / CHUNK_MS));
      },
      onClose: (error) => {
        if (this.session !== session) return;
        this.session = null;
        this.finishing = false;
        if (error) {
          console.error(`[transcriber] stream ${this.streamId}:`, error.message);
          this.schedule(this.options.retryMs);
          return;
        }
        // Everything fed has been flushed into segments.
        this.rooms.setTranscribedUntil(this.streamId, this.nextSeq);
        this.tick();
      },
    });
    this.session = session;
  }

  private finishSession() {
    if (!this.session) return;
    this.finishing = true;
    this.session.finish();
  }
}
