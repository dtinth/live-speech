import OpusScript from "opusscript";
import { PCM_CHUNK_BYTES, SAMPLE_RATE, unpackOpusPackets } from "../shared/protocol.ts";
import type { AudioFormat } from "../shared/transcript.ts";

/**
 * Turns stored chunks into 16 kHz mono 16-bit PCM. Opus decoding keeps state
 * between packets, so use one decoder per pass over a stream, in seq order.
 */
export interface ChunkDecoder {
  decode(chunk: Uint8Array): Uint8Array;
  dispose(): void;
}

export function createChunkDecoder(format: AudioFormat): ChunkDecoder {
  if (format === "pcm16") {
    return { decode: (chunk) => chunk, dispose() {} };
  }
  // opusscript is an Emscripten build, not a native addon: a corrupt packet
  // throws instead of taking the process down.
  const opus = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP, { wasm: true });
  return {
    decode(chunk) {
      const parts: Uint8Array[] = [];
      for (const packet of unpackOpusPackets(chunk)) {
        try {
          parts.push(new Uint8Array(opus.decode(Buffer.from(packet))));
        } catch {
          // Substitute silence of a typical 20 ms frame rather than lose sync.
          parts.push(new Uint8Array(PCM_CHUNK_BYTES / 5));
        }
      }
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let offset = 0;
      for (const p of parts) {
        out.set(p, offset);
        offset += p.byteLength;
      }
      return out;
    },
    dispose() {
      opus.delete();
    },
  };
}
