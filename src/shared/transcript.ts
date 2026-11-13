/**
 * The room event log and the transcript state folded from it.
 * Shared by the server (which appends events) and the viewer (which applies them).
 */

export type AudioFormat = "pcm16" | "opus";

export type RoomEventBody =
  | { type: "stream.started"; streamId: string; format: AudioFormat }
  | { type: "stream.clock"; streamId: string; startedAt: number }
  | { type: "stream.ended"; streamId: string }
  | {
      type: "segment.final";
      segmentId: string;
      streamId: string;
      /** Offset of the segment within its stream, in ms. */
      startMs: number;
      endMs: number;
      text: string;
      source: string;
    }
  | { type: "segment.edited"; segmentId: string; text: string; author: string }
  | { type: "segments.superseded"; segmentIds: string[]; reason: string };

export type RoomEvent = RoomEventBody & { seq: number; at: number };

/** Not part of the log: live, not-yet-final text for a stream. */
export interface LivePartial {
  streamId: string;
  startMs: number;
  text: string;
}

export interface StreamState {
  id: string;
  format: AudioFormat;
  createdAt: number;
  /** Server time of the stream's first chunk, once clock sync has an estimate. */
  startedAt: number | null;
  ended: boolean;
}

export interface SegmentVersion {
  seq: number;
  at: number;
  text: string;
  author: string;
}

export interface SegmentState {
  id: string;
  streamId: string;
  startMs: number;
  endMs: number;
  text: string;
  versions: SegmentVersion[];
  superseded: boolean;
}

export interface TranscriptState {
  seq: number;
  streams: Record<string, StreamState>;
  segments: Record<string, SegmentState>;
}

export function emptyTranscript(): TranscriptState {
  return { seq: 0, streams: {}, segments: {} };
}

/** Applies one event in place. Events must be applied in seq order. */
export function applyEvent(state: TranscriptState, event: RoomEvent): void {
  state.seq = event.seq;
  switch (event.type) {
    case "stream.started":
      state.streams[event.streamId] = {
        id: event.streamId,
        format: event.format,
        createdAt: event.at,
        startedAt: null,
        ended: false,
      };
      break;
    case "stream.clock": {
      const stream = state.streams[event.streamId];
      if (stream) stream.startedAt = event.startedAt;
      break;
    }
    case "stream.ended": {
      const stream = state.streams[event.streamId];
      if (stream) stream.ended = true;
      break;
    }
    case "segment.final":
      state.segments[event.segmentId] = {
        id: event.segmentId,
        streamId: event.streamId,
        startMs: event.startMs,
        endMs: event.endMs,
        text: event.text,
        versions: [{ seq: event.seq, at: event.at, text: event.text, author: event.source }],
        superseded: false,
      };
      break;
    case "segment.edited": {
      const segment = state.segments[event.segmentId];
      if (!segment) break;
      segment.text = event.text;
      segment.versions.push({ seq: event.seq, at: event.at, text: event.text, author: event.author });
      break;
    }
    case "segments.superseded":
      for (const id of event.segmentIds) {
        const segment = state.segments[id];
        if (segment) segment.superseded = true;
      }
      break;
  }
}

/** Server time at which a segment starts, for ordering across streams. */
export function segmentTime(state: TranscriptState, segment: SegmentState): number {
  const stream = state.streams[segment.streamId];
  const base = stream ? (stream.startedAt ?? stream.createdAt) : 0;
  return base + segment.startMs;
}

/** Visible segments in reading order. */
export function orderedSegments(state: TranscriptState): SegmentState[] {
  return Object.values(state.segments)
    .filter((s) => !s.superseded)
    .sort((a, b) => segmentTime(state, a) - segmentTime(state, b));
}
