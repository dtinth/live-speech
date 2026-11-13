import { closeSync, ftruncateSync, mkdirSync, openSync, readSync, rmSync, writeSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Stores a stream's chunks on disk exactly as received, in one append-only
 * file per stream. Each record is a little-endian u32 seq, a u32 length, then
 * the payload. The database records how many chunks (and bytes) are durable;
 * anything past that after a crash is truncated away on the next append.
 */
export class AudioStore {
  constructor(private readonly dir: string) {}

  private path(roomId: string, streamId: string) {
    return join(this.dir, roomId, `${streamId}.chunks`);
  }

  /** Appends chunks starting at `byteLength`; returns the new byte length. */
  append(roomId: string, streamId: string, byteLength: number, chunks: { seq: number; payload: Uint8Array }[]): number {
    mkdirSync(join(this.dir, roomId), { recursive: true });
    const fd = openSync(this.path(roomId, streamId), "a+");
    try {
      ftruncateSync(fd, byteLength);
      let offset = byteLength;
      for (const { seq, payload } of chunks) {
        const header = new Uint8Array(8);
        const view = new DataView(header.buffer);
        view.setUint32(0, seq, true);
        view.setUint32(4, payload.byteLength, true);
        writeSync(fd, header, 0, 8, offset);
        writeSync(fd, payload, 0, payload.byteLength, offset + 8);
        offset += 8 + payload.byteLength;
      }
      return offset;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Reads chunks with `fromSeq <= seq < toSeq`, scanning from `startOffset`
   * (a record boundary, e.g. a previous `nextOffset`) up to `byteLength`.
   */
  *read(
    roomId: string,
    streamId: string,
    byteLength: number,
    { fromSeq = 0, toSeq = Infinity, startOffset = 0 } = {},
  ): Generator<{ seq: number; payload: Uint8Array; nextOffset: number }> {
    const path = this.path(roomId, streamId);
    if (!existsSync(path)) return;
    const fd = openSync(path, "r");
    try {
      let offset = startOffset;
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      while (offset + 8 <= byteLength) {
        readSync(fd, header, 0, 8, offset);
        const seq = view.getUint32(0, true);
        const length = view.getUint32(4, true);
        if (seq >= toSeq) return;
        if (seq >= fromSeq) {
          const payload = new Uint8Array(length);
          readSync(fd, payload, 0, length, offset + 8);
          yield { seq, payload, nextOffset: offset + 8 + length };
        }
        offset += 8 + length;
      }
    } finally {
      closeSync(fd);
    }
  }

  deleteRoom(roomId: string) {
    rmSync(join(this.dir, roomId), { recursive: true, force: true });
  }
}
