import OpusScript from "opusscript";
import { PCM_CHUNK_BYTES, SAMPLE_RATE, unpackOpusPackets } from "../shared/protocol.ts";
import type { AudioFormat } from "../shared/transcript.ts";

/**
 * Turns stored chunks into 16 kHz mono 16-bit PCM, exactly 100 ms
 * (PCM_CHUNK_BYTES) per chunk, so chunk n always starts at n × 100 ms no
 * matter what the encoder did. Opus decoding keeps state between packets, so
 * use one decoder per pass over a stream, in seq order.
 */
export interface ChunkDecoder {
  decode(chunk: Uint8Array): Uint8Array;
  dispose(): void;
}

export function createChunkDecoder(format: AudioFormat): ChunkDecoder {
  if (format === "pcm16") {
    return { decode: (chunk) => fit(chunk), dispose() {} };
  }
  // opusscript is an Emscripten build, not a native addon: a corrupt packet
  // throws instead of taking the process down.
  const opus = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP, { wasm: true });
  return {
    decode(chunk) {
      const packets = unpackOpusPackets(chunk);
      // A chunk with no packets (the encoder dropped frames) still covers
      // 100 ms of the stream; keep later offsets right by decoding it as silence.
      if (packets.length === 0) return new Uint8Array(PCM_CHUNK_BYTES);

      const parts: Uint8Array[] = [];
      for (const packet of packets) {
        try {
          parts.push(new Uint8Array(opus.decode(Buffer.from(packet))));
        } catch {
          // Substitute silence of a typical 20 ms frame rather than lose sync.
          parts.push(new Uint8Array(PCM_CHUNK_BYTES / 5));
        }
      }
      const out = new Uint8Array(PCM_CHUNK_BYTES);
      let offset = 0;
      for (const p of parts) {
        if (offset >= out.byteLength) break;
        out.set(p.subarray(0, out.byteLength - offset), offset);
        offset += p.byteLength;
      }
      return out;
    },
    dispose() {
      opus.delete();
    },
  };
}

/** Pads with silence or truncates to exactly one chunk of PCM. */
function fit(pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength === PCM_CHUNK_BYTES) return pcm;
  const out = new Uint8Array(PCM_CHUNK_BYTES);
  out.set(pcm.subarray(0, PCM_CHUNK_BYTES));
  return out;
}
