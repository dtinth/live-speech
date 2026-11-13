/**
 * A realtime transcription vendor behind one interface.
 *
 * A session receives 16 kHz mono 16-bit PCM at roughly realtime pace and
 * reports text with offsets relative to the first sample it was given. Where
 * voice activity detection happens (at the vendor, or in the adapter) is the
 * adapter's business: callers only see partials and finished segments.
 */
export interface TranscriptionCallbacks {
  /** Live, not-yet-final text of the segment starting at `startMs`. */
  onPartial(startMs: number, text: string): void;
  /** A finished segment. */
  onSegment(startMs: number, endMs: number, text: string): void;
  /** The session can produce nothing more (after finish(), or a fatal error). */
  onClose(error?: Error): void;
}

export interface TranscriptionSession {
  sendAudio(pcm: Uint8Array): void;
  /** Flush pending speech into segments, then close. */
  finish(): void;
  /** Hang up immediately; no further callbacks. */
  close(): void;
}

export interface TranscriptionProvider {
  /** The model; recorded as each segment's source and in usage. */
  readonly name: string;
  /** What the vendor charges per hour of audio fed, in USD (0 if free). */
  readonly pricePerHourUsd: number;
  createSession(callbacks: TranscriptionCallbacks): TranscriptionSession;
}
