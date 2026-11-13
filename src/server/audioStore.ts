import type { Database } from "bun:sqlite";

/**
 * Stores each stream's chunks exactly as received (Opus packets or PCM), one
 * row per 100 ms chunk, in the same SQLite database as everything else. At
 * ~400 bytes per Opus chunk that is ~15 MB per hour, and keeping it in SQLite
 * means a chunk and the stream's chunk count commit in one transaction.
 */
export class AudioStore {
  constructor(private readonly db: Database) {}

  /** Inserts chunks; the caller wraps this in a transaction with its bookkeeping. */
  insert(streamId: string, chunks: { seq: number; payload: Uint8Array }[]) {
    const statement = this.db.query("INSERT INTO chunks (stream_id, seq, payload) VALUES (?, ?, ?)");
    for (const { seq, payload } of chunks) statement.run(streamId, seq, payload);
  }

  /** Chunks with `fromSeq <= seq < toSeq`, in order, fetched in pages. */
  *read(streamId: string, { fromSeq = 0, toSeq = Number.MAX_SAFE_INTEGER } = {}): Generator<{ seq: number; payload: Uint8Array }> {
    const page = this.db.query<{ seq: number; payload: Uint8Array }, [string, number, number]>(
      "SELECT seq, payload FROM chunks WHERE stream_id = ? AND seq >= ? AND seq < ? ORDER BY seq LIMIT 500",
    );
    let next = fromSeq;
    for (;;) {
      const rows = page.all(streamId, next, toSeq);
      for (const row of rows) yield row;
      if (rows.length < 500) return;
      next = rows[rows.length - 1]!.seq + 1;
    }
  }
}
