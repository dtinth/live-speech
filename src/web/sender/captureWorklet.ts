/**
 * AudioWorklet processor source, kept as a string so it can be loaded from a
 * Blob URL. Bun's HTML bundler would otherwise have to emit it as a separate
 * entry point, and addModule() needs a URL to plain JavaScript.
 *
 * It downmixes the input to mono and posts Float32 blocks of about 20 ms
 * (render quanta are only 128 frames; batching keeps message traffic low).
 * Each buffer is transferred, not copied.
 */
export const CAPTURE_PROCESSOR = "live-speech-capture";

export const captureWorkletSource = /* js */ `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate / 50));
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    // No input yet (device still starting): nothing to capture, keep running.
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.buffer[this.filled++] = sum / channels.length;
      if (this.filled === this.size) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR)}, CaptureProcessor);
`;
