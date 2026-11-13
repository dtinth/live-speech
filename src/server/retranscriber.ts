import { CHUNK_MS } from "../shared/protocol.ts";
import type { RoomEventBody } from "../shared/transcript.ts";
import type { AudioStore } from "./audioStore.ts";
import { createChunkDecoder } from "./decoder.ts";
import { randomId, type RoomService } from "./rooms.ts";
import type { TranscriptionProvider } from "./transcription/provider.ts";

/** Give up on a provider that never closes after finish(). */
const FINISH_TIMEOUT_MS = 60_000;

export interface RetranscriptionJob {
  id: string;
  roomId: string;
  streamId: string;
  /** The range actually redone, widened to whole segments and chunks. */
  fromMs: number;
  toMs: number;
  model: string;
  status: "running" | "done" | "failed";
  /** How far into the range audio has been fed. */
  progressMs: number;
  error?: string;
  createdAt: number;
  /** Once done: segments replaced and added. */
  replaced?: number;
  added?: number;
  undone?: boolean;
}

export class RetranscribeError extends Error {}

/**
 * Re-runs stored audio through the provider and swaps the result into the
 * transcript in one step: the old segments in the range are superseded by the
 * new ones, in a single atomic append. Until then nothing changes, so a run
 * that fails (or a server restart mid-run) leaves the transcript as it was.
 * Every run can be undone, which restores the old segments.
 *
 * Only audio the live transcriber has finished with is redone, so the two
 * never produce segments for the same span.
 */
export class Retranscriber {
  private jobs = new Map<string, RetranscriptionJob>();
  private cancels = new Map<string, () => void>();

  constructor(
    private readonly rooms: RoomService,
    private readonly audio: AudioStore,
    private readonly provider: TranscriptionProvider,
    private readonly options: { catchUpSpeed: number },
  ) {}

  list(roomId: string) {
    return [...this.jobs.values()].filter((j) => j.roomId === roomId);
  }

  start(roomId: string, streamId: string, range: { fromMs?: number; toMs?: number } = {}): RetranscriptionJob {
    const stream = this.rooms.getStream(streamId);
    if (!stream || stream.roomId !== roomId) throw new RetranscribeError("No such stream");
    if ([...this.jobs.values()].some((j) => j.streamId === streamId && j.status === "running")) {
      throw new RetranscribeError("This stream is already being re-transcribed");
    }
    const doneMs = stream.transcribedUntil * CHUNK_MS;
    let fromMs = Math.max(0, range.fromMs ?? 0);
    let toMs = Math.min(doneMs, range.toMs ?? doneMs);
    // Widen to whole segments, so none is left half replaced.
    const old = this.liveSegments(roomId, streamId).filter((s) => s.endMs > fromMs && s.startMs < toMs);
    for (const s of old) {
      fromMs = Math.min(fromMs, s.startMs);
      toMs = Math.max(toMs, s.endMs);
    }
    const fromSeq = Math.floor(fromMs / CHUNK_MS);
    const toSeq = Math.min(stream.transcribedUntil, Math.ceil(toMs / CHUNK_MS));
    if (toSeq <= fromSeq) throw new RetranscribeError("Nothing transcribed in that range yet");

    const job: RetranscriptionJob = {
      id: randomId(8),
      roomId,
      streamId,
      fromMs: fromSeq * CHUNK_MS,
      toMs: toSeq * CHUNK_MS,
      model: this.provider.name,
      status: "running",
      progressMs: 0,
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    void this.run(job, stream.format, fromSeq, toSeq);
    return job;
  }

  /**
   * Undoes a finished re-transcription: its segments are superseded and the
   * ones it replaced are restored. Works after a restart, from the log alone.
   */
  undo(roomId: string, jobId: string) {
    const reason = `retranscription:${jobId}`;
    const [swap] = this.rooms.findEventsByReason(roomId, "segments.superseded", reason);
    if (!swap) throw new RetranscribeError("No such re-transcription");
    const undoReason = `undo:${reason}`;
    if (this.rooms.findEventsByReason(roomId, "segments.restored", undoReason).length) {
      throw new RetranscribeError("Already undone");
    }
    this.rooms.appendEvents(roomId, [
      { type: "segments.superseded", segmentIds: swap.replacedBy ?? [], reason: undoReason },
      { type: "segments.restored", segmentIds: swap.segmentIds, reason: undoReason },
    ]);
    const job = this.jobs.get(jobId);
    if (job) job.undone = true;
  }

  /** Abandons running jobs (their results are discarded). */
  stop(roomId?: string) {
    for (const [id, cancel] of this.cancels) {
      if (!roomId || this.jobs.get(id)?.roomId === roomId) cancel();
    }
    if (roomId) for (const job of this.list(roomId)) this.jobs.delete(job.id);
  }

  private liveSegments(roomId: string, streamId: string) {
    return Object.values(this.rooms.getTranscript(roomId).segments).filter(
      (s) => s.streamId === streamId && !s.superseded,
    );
  }

  private async run(job: RetranscriptionJob, format: "pcm16" | "opus", fromSeq: number, toSeq: number) {
    const decoder = createChunkDecoder(format);
    const base = fromSeq * CHUNK_MS;
    const found: { startMs: number; endMs: number; text: string }[] = [];
    let fedMs = 0;
    let cancelled = false;
    let closed!: (error?: Error) => void;
    const closedPromise = new Promise<Error | undefined>((resolve) => (closed = resolve));
    const session = this.provider.createSession({
      onPartial() {},
      onSegment(startMs, endMs, text) {
        if (text.trim()) found.push({ startMs: base + startMs, endMs: base + endMs, text: text.trim() });
      },
      onUsage: (usage) => {
        try {
          this.rooms.addUsage(job.streamId, this.provider.name, usage);
        } catch {}
      },
      onClose: (error) => closed(error),
    });
    this.cancels.set(job.id, () => {
      cancelled = true;
      session.close();
      closed(new Error("Cancelled"));
    });
    try {
      // Feed at catch-up speed: realtime vendors misbehave when fed much faster.
      const speed = this.options.catchUpSpeed;
      let seq = fromSeq;
      let credit = 1;
      let last = performance.now();
      while (seq < toSeq && !cancelled) {
        if (speed !== Infinity) {
          const now = performance.now();
          credit = Math.min(20, credit + ((now - last) * speed) / CHUNK_MS);
          last = now;
        }
        const budget = speed === Infinity ? 500 : Math.floor(credit);
        if (budget > 0) {
          let fed = 0;
          for (const chunk of this.audio.read(job.streamId, { fromSeq: seq, toSeq: Math.min(toSeq, seq + budget) })) {
            session.sendAudio(decoder.decode(chunk.payload));
            seq = chunk.seq + 1;
            fed++;
          }
          if (fed === 0) throw new Error(`Chunk ${seq} is missing`);
          if (speed !== Infinity) credit -= fed;
          fedMs += fed * CHUNK_MS;
          job.progressMs = (seq - fromSeq) * CHUNK_MS;
        }
        await (speed === Infinity ? new Promise((r) => setImmediate(r)) : Bun.sleep(CHUNK_MS));
      }
      if (cancelled) return;
      session.finish();
      const timeout = setTimeout(() => closed(new Error("The provider never finished")), FINISH_TIMEOUT_MS);
      const error = await closedPromise;
      clearTimeout(timeout);
      if (cancelled) return;
      if (error) throw error;
      this.swapIn(job, found);
      job.status = "done";
    } catch (e) {
      session.close();
      job.status = "failed";
      job.error = (e as Error).message;
      console.error(`[retranscriber] job ${job.id}:`, job.error);
    } finally {
      this.cancels.delete(job.id);
      decoder.dispose();
      if (fedMs > 0) {
        try {
          this.rooms.addUsage(job.streamId, this.provider.name, {
            audioMs: fedMs,
            sessions: 1,
            costUsd: this.provider.reportsUsage ? 0 : (fedMs / 3_600_000) * this.provider.pricePerHourUsd,
          });
        } catch {}
      }
    }
  }

  private swapIn(job: RetranscriptionJob, found: { startMs: number; endMs: number; text: string }[]) {
    // Re-read: segments may have been edited or superseded while this ran.
    const old = this.liveSegments(job.roomId, job.streamId).filter(
      (s) => s.startMs >= job.fromMs && s.endMs <= job.toMs,
    );
    const added = found.map((s) => ({ ...s, segmentId: randomId(8) }));
    const reason = `retranscription:${job.id}`;
    const events: RoomEventBody[] = [
      {
        type: "segments.superseded",
        segmentIds: old.map((s) => s.id),
        reason,
        replacedBy: added.map((s) => s.segmentId),
      },
      ...added.map((s): RoomEventBody => ({
        type: "segment.final",
        segmentId: s.segmentId,
        streamId: job.streamId,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        source: this.provider.name,
      })),
    ];
    if (!this.rooms.appendEvents(job.roomId, events)) throw new Error("Room deleted");
    job.replaced = old.length;
    job.added = added.length;
  }
}
