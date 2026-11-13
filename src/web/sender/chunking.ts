/**
 * Turning captured audio into 100 ms chunks. Pure code, unit-tested.
 */
import { CHUNK_MS, PCM_CHUNK_BYTES, SAMPLE_RATE, packOpusPackets } from "../../shared/protocol.ts";

const CHUNK_US = CHUNK_MS * 1000;

/**
 * Groups encoded Opus packets into 100 ms chunks by timestamp.
 *
 * The encoder is fed AudioData whose timestamps count samples from the
 * stream's first sample, so a packet's timestamp says exactly where it sits in
 * the stream. Chunk n gets the packets whose timestamps fall in
 * [n × 100 ms, (n + 1) × 100 ms); with 20 ms frames that is five packets.
 * A chunk is emitted once a packet for a later window shows up (or on flush),
 * so it lags capture by one frame plus the encoder's own delay.
 */
export class OpusChunker {
  private seq = 0;
  private packets: Uint8Array[] = [];

  constructor(private emit: (seq: number, payload: Uint8Array) => void) {}

  /** `timestampUs` is the packet's EncodedAudioChunk timestamp, in µs since the stream began. */
  push(timestampUs: number, packet: Uint8Array) {
    // A microsecond of slack absorbs rounding in sample → µs conversions.
    const window = Math.max(0, Math.floor((timestampUs + 1) / CHUNK_US));
    while (this.seq < window) {
      // An empty window (encoder restarted and lost frames) still gets a
      // chunk, possibly with no packets, so the sequence stays gap-free.
      this.emitCurrent();
    }
    this.packets.push(packet);
  }

  /** Emits the last, possibly partial, chunk. */
  flush() {
    if (this.packets.length > 0) this.emitCurrent();
  }

  private emitCurrent() {
    this.emit(this.seq++, packOpusPackets(this.packets));
    this.packets = [];
  }
}

/**
 * Resamples Float32 mono audio to 16 kHz and slices it into 100 ms Int16 LE
 * chunks of exactly PCM_CHUNK_BYTES.
 *
 * Downsampling averages the input samples that fall under each output sample
 * (a box filter). Crude, but enough anti-aliasing for speech recognition, and
 * it keeps exact sample accounting across calls.
 */
export class Pcm16Chunker {
  private seq = 0;
  private readonly ratio: number;
  /** Position in input samples (relative to the start of `carry`) of the next output sample. */
  private position = 0;
  private carry = new Float32Array(0);
  private chunk = new Int16Array(PCM_CHUNK_BYTES / 2);
  private filled = 0;

  constructor(
    inputRate: number,
    private emit: (seq: number, payload: Uint8Array) => void,
  ) {
    this.ratio = inputRate / SAMPLE_RATE;
  }

  push(samples: Float32Array) {
    const input = new Float32Array(this.carry.length + samples.length);
    input.set(this.carry);
    input.set(samples, this.carry.length);
    const width = Math.max(1, this.ratio);
    let pos = this.position;
    // Upsampling interpolates towards the next input sample, so it needs one more.
    const lookahead = this.ratio <= 1 ? 2 : width;
    while (pos + lookahead <= input.length) {
      this.write(this.sample(input, pos, width));
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.carry = input.slice(keep);
    this.position = pos - keep;
  }

  /** Pads the last chunk with silence and emits it. */
  flush() {
    if (this.filled === 0) return;
    this.chunk.fill(0, this.filled);
    this.filled = this.chunk.length;
    this.emitChunk();
  }

  private sample(input: Float32Array, pos: number, width: number) {
    if (this.ratio <= 1) {
      // Upsampling (input slower than 16 kHz): linear interpolation.
      const i = Math.floor(pos);
      const frac = pos - i;
      return input[i]! * (1 - frac) + input[i + 1]! * frac;
    }
    const from = Math.floor(pos);
    const to = Math.min(input.length, Math.floor(pos + width));
    let sum = 0;
    for (let i = from; i < to; i++) sum += input[i]!;
    return sum / Math.max(1, to - from);
  }

  private write(value: number) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.chunk[this.filled++] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    if (this.filled === this.chunk.length) this.emitChunk();
  }

  private emitChunk() {
    // Int16Array is little-endian on every platform browsers run on.
    this.emit(this.seq++, new Uint8Array(this.chunk.slice().buffer));
    this.filled = 0;
  }
}
