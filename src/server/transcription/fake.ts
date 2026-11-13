import { CHUNK_MS, PCM_CHUNK_BYTES } from "../../shared/protocol.ts";
import type { TranscriptionProvider, TranscriptionSession, TranscriptionCallbacks } from "./provider.ts";

/**
 * A deterministic stand-in for a vendor, for tests and credential-free dev.
 *
 * Audio is taken 100 ms at a time. A chunk whose RMS is above the threshold is
 * speech and contributes one word, `w<first sample value>`; a quiet chunk ends
 * the current segment. So a test can script a transcript by filling chunks
 * with constant sample values, and a real mic produces plausible segments.
 */
export function createFakeProvider({ threshold = 500 } = {}): TranscriptionProvider {
  return {
    name: "fake",
    createSession(callbacks: TranscriptionCallbacks): TranscriptionSession {
      let buffer = new Uint8Array(0);
      let position = 0; // ms of audio consumed
      let current: { startMs: number; words: string[] } | null = null;
      let closed = false;

      const endSegment = (endMs: number) => {
        if (!current) return;
        callbacks.onSegment(current.startMs, endMs, current.words.join(" "));
        current = null;
      };

      const consume = (chunk: Uint8Array) => {
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
        let sum = 0;
        for (const s of samples) sum += s * s;
        const rms = Math.sqrt(sum / samples.length);
        if (rms > threshold) {
          current ??= { startMs: position, words: [] };
          current.words.push(`w${samples[0]}`);
          callbacks.onPartial(current.startMs, current.words.join(" "));
        } else {
          endSegment(position);
        }
        position += CHUNK_MS;
      };

      return {
        sendAudio(pcm) {
          if (closed) return;
          const merged = new Uint8Array(buffer.byteLength + pcm.byteLength);
          merged.set(buffer);
          merged.set(pcm, buffer.byteLength);
          let offset = 0;
          while (offset + PCM_CHUNK_BYTES <= merged.byteLength) {
            consume(merged.slice(offset, offset + PCM_CHUNK_BYTES));
            offset += PCM_CHUNK_BYTES;
          }
          buffer = merged.slice(offset);
        },
        finish() {
          if (closed) return;
          closed = true;
          endSegment(position);
          queueMicrotask(() => callbacks.onClose());
        },
        close() {
          closed = true;
        },
      };
    },
  };
}
