/**
 * Local storage for chunks the server has not acknowledged yet.
 *
 * Every chunk is written here before it is sent, and deleted once the server
 * acks it, so the store only ever holds the unsent backlog. Stream records
 * outlive the page: on load, any stream still listed here is unfinished and
 * gets resumed.
 */
import type { AudioFormat } from "../../shared/transcript.ts";

export interface StoredStream {
  id: string;
  roomId: string;
  format: AudioFormat;
  /** Date.now() when recording began, for display only. */
  createdAt: number;
  /** Recording stopped (or the tab that recorded it is gone): no more chunks will be added. */
  stopped: boolean;
}

export interface StoredChunk {
  seq: number;
  payload: Uint8Array;
}

export interface BacklogStats {
  chunks: number;
  bytes: number;
  /** Lowest and highest stored seq, or null when empty. */
  first: number | null;
  last: number | null;
}

export interface ChunkStore {
  listStreams(): Promise<StoredStream[]>;
  putStream(stream: StoredStream): Promise<void>;
  /** Removes the stream record and any chunks it still has. */
  deleteStream(streamId: string): Promise<void>;
  putChunk(streamId: string, chunk: StoredChunk): Promise<void>;
  /** Chunks with seq >= fromSeq, in order, at most `limit` of them. */
  getChunks(streamId: string, fromSeq: number, limit: number): Promise<StoredChunk[]>;
  /** Deletes chunks with seq < beforeSeq; returns how many and how big they were. */
  deleteChunksBelow(streamId: string, beforeSeq: number): Promise<{ chunks: number; bytes: number }>;
  stats(streamId: string): Promise<BacklogStats>;
}

/** For tests: same semantics, kept in memory (so it survives a simulated reload if reused). */
export class MemoryChunkStore implements ChunkStore {
  private streams = new Map<string, StoredStream>();
  private chunks = new Map<string, Map<number, Uint8Array>>();

  async listStreams() {
    return [...this.streams.values()].map((s) => ({ ...s }));
  }

  async putStream(stream: StoredStream) {
    this.streams.set(stream.id, { ...stream });
  }

  async deleteStream(streamId: string) {
    this.streams.delete(streamId);
    this.chunks.delete(streamId);
  }

  async putChunk(streamId: string, chunk: StoredChunk) {
    let map = this.chunks.get(streamId);
    if (!map) this.chunks.set(streamId, (map = new Map()));
    map.set(chunk.seq, chunk.payload.slice());
  }

  async getChunks(streamId: string, fromSeq: number, limit: number) {
    const map = this.chunks.get(streamId);
    if (!map) return [];
    return [...map.keys()]
      .filter((seq) => seq >= fromSeq)
      .sort((a, b) => a - b)
      .slice(0, limit)
      .map((seq) => ({ seq, payload: map.get(seq)! }));
  }

  async deleteChunksBelow(streamId: string, beforeSeq: number) {
    const map = this.chunks.get(streamId);
    let chunks = 0;
    let bytes = 0;
    if (map) {
      for (const [seq, payload] of map) {
        if (seq < beforeSeq) {
          map.delete(seq);
          chunks++;
          bytes += payload.byteLength;
        }
      }
    }
    return { chunks, bytes };
  }

  async stats(streamId: string) {
    const map = this.chunks.get(streamId);
    const seqs = map ? [...map.keys()] : [];
    return {
      chunks: seqs.length,
      bytes: seqs.reduce((n, seq) => n + map!.get(seq)!.byteLength, 0),
      first: seqs.length ? Math.min(...seqs) : null,
      last: seqs.length ? Math.max(...seqs) : null,
    };
  }

  /** Test helper: every stored seq for a stream. */
  storedSeqs(streamId: string) {
    return [...(this.chunks.get(streamId)?.keys() ?? [])].sort((a, b) => a - b);
  }
}

const DB_NAME = "live-speech-sender";
const STREAMS = "streams";
const CHUNKS = "chunks";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

interface ChunkRow {
  streamId: string;
  seq: number;
  payload: ArrayBuffer;
}

/**
 * Chunks are keyed by [streamId, seq] so a stream's backlog is one contiguous
 * key range. Transactions use the default (relaxed) durability: a completed
 * write survives a tab or browser crash, which is what we need, without an
 * fsync ten times a second.
 */
export class IndexedDbChunkStore implements ChunkStore {
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<IndexedDbChunkStore> {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(STREAMS, { keyPath: "id" });
      db.createObjectStore(CHUNKS, { keyPath: ["streamId", "seq"] });
    };
    return new IndexedDbChunkStore(await request(req));
  }

  private range(streamId: string, from = 0, to = Number.MAX_SAFE_INTEGER, toOpen = false) {
    return IDBKeyRange.bound([streamId, from], [streamId, to], false, toOpen);
  }

  async listStreams() {
    const tx = this.db.transaction(STREAMS, "readonly");
    return request(tx.objectStore(STREAMS).getAll() as IDBRequest<StoredStream[]>);
  }

  async putStream(stream: StoredStream) {
    const tx = this.db.transaction(STREAMS, "readwrite");
    tx.objectStore(STREAMS).put(stream);
    await done(tx);
  }

  async deleteStream(streamId: string) {
    const tx = this.db.transaction([STREAMS, CHUNKS], "readwrite");
    tx.objectStore(STREAMS).delete(streamId);
    tx.objectStore(CHUNKS).delete(this.range(streamId));
    await done(tx);
  }

  async putChunk(streamId: string, chunk: StoredChunk) {
    const tx = this.db.transaction(CHUNKS, "readwrite");
    const row: ChunkRow = { streamId, seq: chunk.seq, payload: chunk.payload.slice().buffer as ArrayBuffer };
    tx.objectStore(CHUNKS).put(row);
    await done(tx);
  }

  async getChunks(streamId: string, fromSeq: number, limit: number) {
    const tx = this.db.transaction(CHUNKS, "readonly");
    const rows = (await request(tx.objectStore(CHUNKS).getAll(this.range(streamId, fromSeq), limit))) as ChunkRow[];
    return rows.map((r) => ({ seq: r.seq, payload: new Uint8Array(r.payload) }));
  }

  async deleteChunksBelow(streamId: string, beforeSeq: number) {
    if (beforeSeq <= 0) return { chunks: 0, bytes: 0 };
    const tx = this.db.transaction(CHUNKS, "readwrite");
    const store = tx.objectStore(CHUNKS);
    const range = this.range(streamId, 0, beforeSeq, true);
    // Read sizes first so the caller can keep its byte count without rescanning.
    const rows = (await request(store.getAll(range))) as ChunkRow[];
    store.delete(range);
    await done(tx);
    return { chunks: rows.length, bytes: rows.reduce((n, r) => n + r.payload.byteLength, 0) };
  }

  async stats(streamId: string) {
    const tx = this.db.transaction(CHUNKS, "readonly");
    const store = tx.objectStore(CHUNKS);
    const range = this.range(streamId);
    let chunks = 0;
    let bytes = 0;
    let first: number | null = null;
    let last: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const req = store.openCursor(range);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const row = cursor.value as ChunkRow;
        chunks++;
        bytes += row.payload.byteLength;
        first ??= row.seq;
        last = row.seq;
        cursor.continue();
      };
    });
    return { chunks, bytes, first, last };
  }
}
