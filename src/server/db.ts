import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- Estimated server time (ms since epoch) of chunk 0, from clock sync.
  started_at INTEGER,
  -- Round-trip time of the ping that produced started_at; lower is better.
  clock_rtt INTEGER,
  -- Chunks durably stored: every seq below this is on disk.
  chunk_count INTEGER NOT NULL DEFAULT 0,
  -- Chunks below this have been transcribed and their segments logged.
  transcribed_until INTEGER NOT NULL DEFAULT 0,
  ended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS streams_room ON streams(room_id);

-- Audio exactly as the sender encoded it, one row per 100 ms chunk.
CREATE TABLE IF NOT EXISTS chunks (
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (stream_id, seq)
);

-- Append-only log. Every transcript state is a fold over this table.
CREATE TABLE IF NOT EXISTS events (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq)
);

-- What the transcription vendor billed, per stream and model. Audio fed twice
-- (a retry after a vendor error, a re-transcription) is billed twice.
-- cost_usd accrues at the price in effect when the audio was fed.
CREATE TABLE IF NOT EXISTS usage (
  stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  audio_ms INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (stream_id, model)
);
`;

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "live-speech.sqlite"), { create: true, strict: true });
  // Lets deleting a room give space back. It only takes effect on a database
  // that already has tables after a full VACUUM, so do that once if needed.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()!.auto_vacuum !== 2) db.exec("VACUUM");
  db.exec("PRAGMA journal_mode = WAL");
  // An ack tells the sender it may delete its copy, so a commit must survive
  // power loss: fsync every transaction.
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
