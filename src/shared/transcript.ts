/**
 * The room event log and the transcript state folded from it.
 * Shared by the server (which appends events) and the viewer (which applies them).
 */

export type AudioFormat = "pcm16" | "opus";

/** A word's timing, in ms from the start of its stream (as the ASR heard it). */
export interface WordTiming {
  startMs: number;
  endMs: number;
  text: string;
}

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
      /**
       * Word timings, if the model gives them. They follow the ASR text, not later
       * edits. For Thai, Qwen gives sub-word tokens that join up into the text.
       */
      words?: WordTiming[];
    }
  | { type: "segment.edited"; segmentId: string; text: string; author: string }
  | {
      type: "segments.superseded";
      segmentIds: string[];
      reason: string;
      /** The segments that took their place, if any (a re-transcription's output). */
      replacedBy?: string[];
    }
  /** The viewer's custom CSS, set by an admin (empty for none). */
  | { type: "room.style"; css: string }
  /** Brings superseded segments back, e.g. when a re-transcription is undone. */
  | { type: "segments.restored"; segmentIds: string[]; reason: string };

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
  /** Word timings from the ASR, if any (see segment.final). */
  words?: WordTiming[];
}

export interface TranscriptState {
  seq: number;
  streams: Record<string, StreamState>;
  segments: Record<string, SegmentState>;
  /** Custom CSS for the viewer. */
  css: string;
}

export function emptyTranscript(): TranscriptState {
  return { seq: 0, streams: {}, segments: {}, css: "" };
}

/**
 * Applies one event, in seq order. The state's maps are updated in place, but
 * a changed stream or segment is replaced by a new object rather than
 * mutated, so a UI can copy just the maps and memoize per segment.
 */
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
      if (stream) state.streams[event.streamId] = { ...stream, startedAt: event.startedAt };
      break;
    }
    case "stream.ended": {
      const stream = state.streams[event.streamId];
      if (stream) state.streams[event.streamId] = { ...stream, ended: true };
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
        ...(event.words ? { words: event.words } : {}),
      };
      break;
    case "segment.edited": {
      const segment = state.segments[event.segmentId];
      if (!segment) break;
      state.segments[event.segmentId] = {
        ...segment,
        text: event.text,
        versions: [...segment.versions, { seq: event.seq, at: event.at, text: event.text, author: event.author }],
      };
      break;
    }
    case "segments.superseded":
      for (const id of event.segmentIds) {
        const segment = state.segments[id];
        if (segment) state.segments[id] = { ...segment, superseded: true };
      }
      break;
    case "room.style":
      state.css = event.css;
      break;
    case "segments.restored":
      for (const id of event.segmentIds) {
        const segment = state.segments[id];
        if (segment) state.segments[id] = { ...segment, superseded: false };
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
