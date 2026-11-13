import { CHUNK_MS } from "../shared/protocol.ts";
import type { WordTiming } from "../shared/transcript.ts";
import type { AudioStore } from "./audioStore.ts";
import { createChunkDecoder, type ChunkDecoder } from "./decoder.ts";
import { randomId, type RoomService } from "./rooms.ts";
import type { TranscriptionProvider, TranscriptionSession } from "./transcription/provider.ts";

/** At most this much audio (2 s) may be fed in one burst. */
const MAX_CREDIT_CHUNKS = 20;
/** Usage is written to the database at least this often while feeding. */
const USAGE_FLUSH_MS = 5000;

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

  /** Stops transcribing these streams (e.g. their room is being deleted). */
  forget(streamIds: string[]) {
    for (const id of streamIds) {
      this.workers.get(id)?.stop();
      this.workers.delete(id);
    }
  }
}

/** Word timings from session-relative to stream offsets. */
export function shiftWords(words: WordTiming[], base: number): WordTiming[] {
  return words.map((w) => ({ startMs: base + w.startMs, endMs: base + w.endMs, text: w.text }));
}

class StreamWorker {
  private session: TranscriptionSession | null = null;
  private decoder: ChunkDecoder | null = null;
  /** Chunk seq the current session began at; provider offsets are relative to it. */
  private baseSeq = 0;
  /** Next chunk to feed. */
  private nextSeq = 0;
  /** Pacing credit in chunks (a token bucket), and when it was last topped up. */
  private credit = 0;
  private creditAt = 0;
  private lastFedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The pending timer is only waiting out idleness, so new audio may cut it short. */
  private timerIsIdleWait = false;
  private stopped = false;
  private finishing = false;
  /** Fed audio and opened sessions not yet recorded in usage. */
  private unbilledMs = 0;
  private unbilledSessions = 0;
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
    if (this.stopped) return;
    if (this.timer && this.timerIsIdleWait) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.recordUsage();
    this.session?.close();
    this.decoder?.dispose();
    this.resolveDone();
  }

  private exit() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.recordUsage();
    this.session?.close();
    this.session = null;
    this.decoder?.dispose();
    this.decoder = null;
    this.onExit();
    this.resolveDone();
  }

  private schedule(ms: number, idleWait = false) {
    if (this.stopped || this.timer) return;
    this.timerIsIdleWait = idleWait;
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

    // Feed as much as the pacing budget allows. Credit accrues at catchUpSpeed
    // but is capped, so time spent waiting for live audio can't be saved up
    // and spent later as one big burst.
    const now = performance.now();
    const speed = this.options.catchUpSpeed;
    if (speed !== Infinity) {
      this.credit = Math.min(MAX_CREDIT_CHUNKS, this.credit + ((now - this.creditAt) * speed) / CHUNK_MS);
      this.creditAt = now;
    }
    const budget = speed === Infinity ? Infinity : Math.floor(this.credit);
    let fed = 0;
    if (budget > 0 && this.nextSeq < stream.chunkCount) {
      const toSeq = budget === Infinity ? stream.chunkCount : Math.min(stream.chunkCount, this.nextSeq + budget);
      for (const chunk of this.audio.read(stream.id, { fromSeq: this.nextSeq, toSeq })) {
        this.session!.sendAudio(this.decoder!.decode(chunk.payload));
        this.nextSeq = chunk.seq + 1;
        fed++;
      }
      if (fed === 0) {
        // The stream claims chunks the store doesn't have; feeding can't progress.
        console.error(`[transcriber] stream ${this.streamId}: chunk ${this.nextSeq} is missing`);
        this.session?.close();
        this.session = null;
        return this.exit();
      }
    }
    if (fed > 0) {
      this.lastFedAt = now;
      this.unbilledMs += fed * CHUNK_MS;
      if (this.unbilledMs >= USAGE_FLUSH_MS) this.recordUsage();
    }
    if (speed !== Infinity) this.credit -= fed;

    const caughtUp = this.nextSeq >= stream.chunkCount;
    if (caughtUp && (stream.ended || now - this.lastFedAt >= this.options.idleMs)) {
      this.finishSession();
      return;
    }
    if (!caughtUp) {
      this.schedule(this.options.catchUpSpeed === Infinity ? 0 : 20);
    } else {
      // Wait for more audio (notify() wakes us) or for the idle timeout.
      this.schedule(Math.max(0, this.options.idleMs - (now - this.lastFedAt)), true);
    }
  }

  private startSession(fromSeq: number) {
    const stream = this.rooms.getStream(this.streamId)!;
    this.baseSeq = fromSeq;
    this.nextSeq = fromSeq;
    this.lastFedAt = performance.now();
    // Start with one chunk's worth so the first audio goes out at once.
    this.credit = 1;
    this.creditAt = this.lastFedAt;
    this.decoder?.dispose();
    this.decoder = createChunkDecoder(stream.format);
    const base = fromSeq * CHUNK_MS;
    const roomId = stream.roomId;
    const session = this.provider.createSession({
      onPartial: (startMs, text) => {
        if (this.session !== session) return;
        this.rooms.setPartial(roomId, { streamId: this.streamId, startMs: base + startMs, text });
      },
      onSegment: (startMs, endMs, text, words) => {
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
            ...(words ? { words: shiftWords(words, base) } : {}),
          });
        }
        this.rooms.setTranscribedUntil(this.streamId, Math.floor((base + endMs) / CHUNK_MS));
      },
      onUsage: (usage) => {
        try {
          this.rooms.addUsage(this.streamId, this.provider.name, usage);
        } catch (e) {
          console.error(`[transcriber] stream ${this.streamId}: recording usage failed:`, (e as Error).message);
        }
      },
      onClose: (error) => {
        if (this.session !== session) return;
        this.session = null;
        this.recordUsage();
        this.finishing = false;
        // Whatever was still in progress won't be finished by this session.
        if (this.rooms.getPartials(roomId).some((p) => p.streamId === this.streamId)) {
          this.rooms.setPartial(roomId, { streamId: this.streamId, startMs: Number.MAX_SAFE_INTEGER, text: "" }, true);
        }
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
    this.unbilledSessions++;
  }

  /** Writes fed audio to the usage table, priced at the provider's current rate. */
  private recordUsage() {
    if (this.unbilledMs === 0 && this.unbilledSessions === 0) return;
    const audioMs = this.unbilledMs;
    try {
      this.rooms.addUsage(this.streamId, this.provider.name, {
        audioMs,
        sessions: this.unbilledSessions,
        costUsd: this.provider.reportsUsage ? 0 : (audioMs / 3_600_000) * this.provider.pricePerHourUsd,
      });
      this.unbilledMs = 0;
      this.unbilledSessions = 0;
    } catch (e) {
      // Keep the count and try again on the next flush.
      console.error(`[transcriber] stream ${this.streamId}: recording usage failed:`, (e as Error).message);
    }
  }

  private finishSession() {
    if (!this.session) return;
    this.finishing = true;
    this.session.finish();
  }
}
