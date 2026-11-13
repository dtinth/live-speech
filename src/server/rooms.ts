import type { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AudioStore } from "./audioStore.ts";
import { roomChannel, type Publisher } from "./publisher.ts";
import {
  applyEvent,
  emptyTranscript,
  type AudioFormat,
  type LivePartial,
  type RoomEvent,
  type RoomEventBody,
  type TranscriptState,
} from "../shared/transcript.ts";

export interface Room {
  id: string;
  name: string;
  password: string;
  createdAt: number;
}

export interface StreamRecord {
  id: string;
  roomId: string;
  format: AudioFormat;
  createdAt: number;
  startedAt: number | null;
  clockRtt: number | null;
  chunkCount: number;
  transcribedUntil: number;
  ended: boolean;
}

/** Live payloads pushed to viewers. `event` is logged; `partial` is not. */
export type LiveMessage =
  | { kind: "event"; event: RoomEvent }
  | { kind: "partial"; seq: number; partial: LivePartial; cleared: boolean };

export function randomId(bytes = 6) {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface StreamRow {
  id: string;
  room_id: string;
  format: AudioFormat;
  created_at: number;
  started_at: number | null;
  clock_rtt: number | null;
  chunk_count: number;
  transcribed_until: number;
  ended: number;
}

function toStream(row: StreamRow): StreamRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    format: row.format,
    createdAt: row.created_at,
    startedAt: row.started_at,
    clockRtt: row.clock_rtt,
    chunkCount: row.chunk_count,
    transcribedUntil: row.transcribed_until,
    ended: !!row.ended,
  };
}

/**
 * Rooms, their streams, and their append-only event logs. The one place that
 * writes to the database, so that every logged change is also published.
 */
export class RoomService {
  private transcripts = new Map<string, TranscriptState>();
  private partials = new Map<string, Map<string, LivePartial>>();
  private listeners = new Set<(roomId: string, message: LiveMessage) => void>();
  private publishQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly audio: AudioStore,
    private readonly publisher: Publisher,
    private readonly now: () => number = Date.now,
  ) {}

  // Rooms

  createRoom(name: string): Room {
    const room: Room = { id: randomId(), name, password: randomId(12), createdAt: this.now() };
    this.db
      .query("INSERT INTO rooms (id, name, password, created_at) VALUES (?, ?, ?, ?)")
      .run(room.id, room.name, room.password, room.createdAt);
    return room;
  }

  listRooms(): Room[] {
    return this.db
      .query<{ id: string; name: string; password: string; created_at: number }, []>(
        "SELECT * FROM rooms ORDER BY created_at DESC",
      )
      .all()
      .map((r) => ({ id: r.id, name: r.name, password: r.password, createdAt: r.created_at }));
  }

  getRoom(id: string): Room | null {
    const r = this.db
      .query<{ id: string; name: string; password: string; created_at: number }, [string]>(
        "SELECT * FROM rooms WHERE id = ?",
      )
      .get(id);
    return r ? { id: r.id, name: r.name, password: r.password, createdAt: r.created_at } : null;
  }

  checkPassword(roomId: string, password: string): boolean {
    const room = this.getRoom(roomId);
    return !!room && safeEqual(room.password, password);
  }

  regeneratePassword(roomId: string): Room | null {
    this.db.query("UPDATE rooms SET password = ? WHERE id = ?").run(randomId(12), roomId);
    return this.getRoom(roomId);
  }

  deleteRoom(roomId: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM chunks WHERE stream_id IN (SELECT id FROM streams WHERE room_id = ?)").run(roomId);
      this.db.query("DELETE FROM events WHERE room_id = ?").run(roomId);
      this.db.query("DELETE FROM streams WHERE room_id = ?").run(roomId);
      this.db.query("DELETE FROM rooms WHERE id = ?").run(roomId);
    })();
    // Return the freed pages to the filesystem.
    this.db.exec("PRAGMA incremental_vacuum");
    this.transcripts.delete(roomId);
    this.partials.delete(roomId);
  }

  // Streams

  getStream(streamId: string): StreamRecord | null {
    const row = this.db.query<StreamRow, [string]>("SELECT * FROM streams WHERE id = ?").get(streamId);
    return row ? toStream(row) : null;
  }

  listStreams(roomId?: string): StreamRecord[] {
    const rows = roomId
      ? this.db.query<StreamRow, [string]>("SELECT * FROM streams WHERE room_id = ? ORDER BY created_at").all(roomId)
      : this.db.query<StreamRow, []>("SELECT * FROM streams ORDER BY created_at").all();
    return rows.map(toStream);
  }

  /** Returns the stream, creating it (and logging `stream.started`) if new. */
  openStream(roomId: string, streamId: string, format: AudioFormat): StreamRecord {
    const existing = this.getStream(streamId);
    if (existing) {
      if (existing.roomId !== roomId) throw new Error("Stream belongs to another room");
      if (existing.format !== format) throw new Error("Stream format mismatch");
      return existing;
    }
    this.db
      .query("INSERT INTO streams (id, room_id, format, created_at) VALUES (?, ?, ?, ?)")
      .run(streamId, roomId, format, this.now());
    this.appendEvent(roomId, { type: "stream.started", streamId, format });
    return this.getStream(streamId)!;
  }

  /** Durably stores chunks `next, next+1, …` and returns the new chunk count. */
  appendChunks(stream: StreamRecord, chunks: { seq: number; payload: Uint8Array }[]): number {
    return this.db.transaction(() => {
      const current = this.getStream(stream.id)!;
      const fresh = chunks.filter((c) => c.seq >= current.chunkCount);
      if (fresh.length === 0) return current.chunkCount;
      fresh.forEach((c, i) => {
        if (c.seq !== current.chunkCount + i) throw new Error(`Gap: expected chunk ${current.chunkCount + i}, got ${c.seq}`);
      });
      this.audio.insert(stream.id, fresh);
      const chunkCount = current.chunkCount + fresh.length;
      this.db.query("UPDATE streams SET chunk_count = ? WHERE id = ?").run(chunkCount, stream.id);
      return chunkCount;
    })();
  }

  /** Records a clock-sync sample; keeps it only if its round trip beats the best so far. */
  updateClock(streamId: string, startedAt: number, rtt: number) {
    const stream = this.getStream(streamId);
    if (!stream) return;
    if (stream.clockRtt !== null && stream.clockRtt <= rtt) return;
    this.db.query("UPDATE streams SET started_at = ?, clock_rtt = ? WHERE id = ?").run(startedAt, rtt, streamId);
    // Only log estimates that move the stream noticeably, to keep the log quiet.
    if (stream.startedAt === null || Math.abs(stream.startedAt - startedAt) >= 50) {
      this.appendEvent(stream.roomId, { type: "stream.clock", streamId, startedAt });
    }
  }

  endStream(streamId: string) {
    const stream = this.getStream(streamId);
    if (!stream || stream.ended) return;
    this.db.query("UPDATE streams SET ended = 1 WHERE id = ?").run(streamId);
    this.appendEvent(stream.roomId, { type: "stream.ended", streamId });
  }

  setTranscribedUntil(streamId: string, seq: number) {
    this.db
      .query("UPDATE streams SET transcribed_until = max(transcribed_until, ?) WHERE id = ?")
      .run(seq, streamId);
  }

  // Event log

  appendEvent(roomId: string, body: RoomEventBody): RoomEvent {
    const transcript = this.getTranscript(roomId);
    const event = { ...body, seq: transcript.seq + 1, at: this.now() } as RoomEvent;
    this.db
      .query("INSERT INTO events (room_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(roomId, event.seq, event.type, JSON.stringify(body), event.at);
    applyEvent(transcript, event);
    this.broadcast(roomId, { kind: "event", event });
    return event;
  }

  eventsSince(roomId: string, after: number, limit = 1000): RoomEvent[] {
    return this.db
      .query<{ seq: number; payload: string; created_at: number }, [string, number, number]>(
        "SELECT seq, payload, created_at FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(roomId, after, limit)
      .map((r) => ({ ...JSON.parse(r.payload), seq: r.seq, at: r.created_at }));
  }

  getTranscript(roomId: string): TranscriptState {
    let transcript = this.transcripts.get(roomId);
    if (!transcript) {
      transcript = emptyTranscript();
      let after = 0;
      for (;;) {
        const batch = this.eventsSince(roomId, after, 10000);
        for (const event of batch) applyEvent(transcript, event);
        if (batch.length < 10000) break;
        after = batch[batch.length - 1]!.seq;
      }
      this.transcripts.set(roomId, transcript);
    }
    return transcript;
  }

  // Partials (live, unlogged)

  getPartials(roomId: string): LivePartial[] {
    return [...(this.partials.get(roomId)?.values() ?? [])];
  }

  setPartial(roomId: string, partial: LivePartial, cleared = false) {
    let map = this.partials.get(roomId);
    if (!map) this.partials.set(roomId, (map = new Map()));
    if (cleared) map.delete(partial.streamId);
    else map.set(partial.streamId, partial);
    this.broadcast(roomId, { kind: "partial", seq: this.getTranscript(roomId).seq, partial, cleared });
  }

  // Fan-out

  /** In-process subscribers (e.g. tests); viewers get the same via the publisher. */
  subscribe(listener: (roomId: string, message: LiveMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private broadcast(roomId: string, message: LiveMessage) {
    for (const listener of this.listeners) listener(roomId, message);
    // Publish one at a time per room, so viewers receive events in seq order.
    const previous = this.publishQueues.get(roomId) ?? Promise.resolve();
    const next = previous.then(() => this.publisher.publish(roomChannel(roomId), message.kind, message));
    this.publishQueues.set(roomId, next);
    void next.finally(() => {
      if (this.publishQueues.get(roomId) === next) this.publishQueues.delete(roomId);
    });
  }

  /** Resolves once everything broadcast so far has been handed to the publisher. */
  async flushPublishes() {
    await Promise.all(this.publishQueues.values());
  }
}
