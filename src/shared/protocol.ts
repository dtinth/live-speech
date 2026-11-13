/**
 * Sender ⇄ server WebSocket protocol, one connection per stream.
 *
 * Text frames are JSON. Audio goes in binary frames: a little-endian u32 chunk
 * sequence number followed by the chunk payload.
 *
 * 1. Client sends `hello`. Server answers `ready` with the next chunk it needs.
 * 2. Client sends chunks from `next` onwards, in order. Server answers `ack`
 *    once they are on disk. Chunks below `next` are ignored; a chunk beyond
 *    `next` (a gap) is rejected with `error` and the connection is closed.
 * 3. Server sends `ping` from time to time; client answers `pong` at once with
 *    its monotonic ms since the stream's chunk 0 began. This is how the server
 *    places the stream on its own clock without trusting the client's.
 * 4. Client sends `end` when recording stops for good.
 */
import type { AudioFormat } from "./transcript.ts";

export const CHUNK_MS = 100;
export const SAMPLE_RATE = 16000;
export const PCM_CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

export type ClientMessage =
  | { type: "hello"; password: string; streamId: string; format: AudioFormat }
  | { type: "pong"; id: number; elapsed: number }
  | { type: "end" };

export type ServerMessage =
  | { type: "ready"; next: number }
  | { type: "ack"; next: number }
  | { type: "ping"; id: number }
  | { type: "error"; message: string };

export function encodeChunkFrame(seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, seq, true);
  frame.set(payload, 4);
  return frame;
}

export function decodeChunkFrame(frame: Uint8Array): { seq: number; payload: Uint8Array } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { seq: view.getUint32(0, true), payload: frame.subarray(4) };
}

/**
 * An Opus chunk holds several encoded packets (20 ms each by default), each
 * prefixed with a little-endian u16 length.
 */
export function packOpusPackets(packets: Uint8Array[]): Uint8Array {
  const total = packets.reduce((n, p) => n + 2 + p.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of packets) {
    view.setUint16(offset, p.byteLength, true);
    out.set(p, offset + 2);
    offset += 2 + p.byteLength;
  }
  return out;
}

export function unpackOpusPackets(chunk: Uint8Array): Uint8Array[] {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const packets: Uint8Array[] = [];
  let offset = 0;
  while (offset + 2 <= chunk.byteLength) {
    const length = view.getUint16(offset, true);
    packets.push(chunk.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return packets;
}
