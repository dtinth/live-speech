/**
 * Microphone → AudioWorklet → (Opus encoder | 16 kHz PCM) → 100 ms chunks.
 */
import type { AudioFormat } from "../../shared/transcript.ts";
import { CAPTURE_PROCESSOR, captureWorkletSource } from "./captureWorklet.ts";
import { OpusChunker, Pcm16Chunker } from "./chunking.ts";

export interface RecorderOptions {
  deviceId?: string;
  /** Browser echo cancellation, noise suppression and AGC. Off by default: the input is usually a venue feed. */
  processing?: boolean;
  /** Force a format; by default Opus when the browser can encode it, else PCM. */
  format?: AudioFormat;
  onChunk(seq: number, payload: Uint8Array): void;
  /** Peak level (0–1) of each captured block, for a meter. */
  onLevel?(peak: number): void;
  onError?(error: Error): void;
}

const OPUS_BITRATE = 32_000;
const OPUS_FRAME_US = 20_000;

function opusConfig(sampleRate: number): AudioEncoderConfig {
  return {
    codec: "opus",
    sampleRate,
    numberOfChannels: 1,
    bitrate: OPUS_BITRATE,
    opus: { frameDuration: OPUS_FRAME_US },
  };
}

/** Whether WebCodecs can encode Opus at this sample rate. */
export async function canEncodeOpus(sampleRate: number): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const support = await AudioEncoder.isConfigSupported(opusConfig(sampleRate));
    return support.supported === true;
  } catch {
    return false;
  }
}

/** Lists audio inputs. Labels are empty until the page has mic permission. */
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export class Recorder {
  readonly format: AudioFormat;
  /**
   * performance.now() at the moment chunk 0 began, once the first audio
   * arrives. Clock-sync pongs report time since this.
   */
  startedAt: number | null = null;
  private stopped = false;

  private constructor(
    format: AudioFormat,
    private context: AudioContext,
    private media: MediaStream,
    private source: MediaStreamAudioSourceNode,
    private node: AudioWorkletNode,
    private encoder: AudioEncoder | null,
    private chunker: OpusChunker | Pcm16Chunker,
  ) {
    this.format = format;
  }

  /**
   * Asks for the mic and starts capturing right away. Chunks begin arriving
   * through `onChunk` about 100 ms later, regardless of any network state.
   */
  static async start(options: RecorderOptions): Promise<Recorder> {
    const processing = options.processing ?? false;
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
        channelCount: { ideal: 1 },
      },
    });
    let context: AudioContext | null = null;
    try {
      // Let the context run at the hardware rate: Opus encodes at any rate,
      // and the PCM path resamples itself (Firefox can't connect a mic to a
      // context at a different rate).
      context = new AudioContext({ latencyHint: "interactive" });
      const sampleRate = context.sampleRate;
      const format = options.format ?? ((await canEncodeOpus(sampleRate)) ? "opus" : "pcm16");

      const url = URL.createObjectURL(new Blob([captureWorkletSource], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const source = context.createMediaStreamSource(media);
      const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCountMode: "max",
      });

      let encoder: AudioEncoder | null = null;
      let chunker: OpusChunker | Pcm16Chunker;
      if (format === "opus") {
        const opus = new OpusChunker(options.onChunk);
        chunker = opus;
        encoder = createOpusEncoder(sampleRate, opus, options.onError);
      } else {
        chunker = new Pcm16Chunker(sampleRate, options.onChunk);
      }

      const recorder = new Recorder(format, context, media, source, node, encoder, chunker);
      recorder.wire(sampleRate, options);
      source.connect(node);
      if (context.state === "suspended") await context.resume();
      return recorder;
    } catch (error) {
      media.getTracks().forEach((t) => t.stop());
      await context?.close().catch(() => {});
      throw error;
    }
  }

  private wire(sampleRate: number, options: RecorderOptions) {
    /** Samples captured so far: the stream's own clock, from which Opus timestamps derive. */
    let samples = 0;
    this.node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => {
      if (this.stopped) return;
      const block = e.data;
      if (this.startedAt === null) {
        // The block's first sample was captured about one block earlier.
        this.startedAt = performance.now() - (block.length / sampleRate) * 1000;
      }
      let peak = 0;
      for (let i = 0; i < block.length; i++) peak = Math.max(peak, Math.abs(block[i]!));
      options.onLevel?.(peak);

      if (this.chunker instanceof Pcm16Chunker) {
        this.chunker.push(block);
      } else {
        if (!this.encoder || this.encoder.state === "closed") {
          // The encoder died (e.g. reclaimed by the browser). Start a fresh
          // one; timestamps keep counting, so chunks stay aligned.
          this.encoder = createOpusEncoder(sampleRate, this.chunker, options.onError);
        }
        const data = new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: block.length,
          numberOfChannels: 1,
          timestamp: Math.round((samples / sampleRate) * 1e6),
          data: block,
        });
        this.encoder.encode(data);
        data.close();
      }
      samples += block.length;
    };
    this.media.getAudioTracks()[0]?.addEventListener("ended", () => {
      options.onError?.(new Error("The audio input ended (device unplugged or permission revoked)"));
    });
  }

  /** Milliseconds since chunk 0 began, on this page's monotonic clock. */
  elapsed(): number {
    return this.startedAt === null ? 0 : performance.now() - this.startedAt;
  }

  /** Stops capture and emits the final chunk(s). */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.source.disconnect();
    this.node.port.onmessage = null;
    this.media.getTracks().forEach((t) => t.stop());
    if (this.encoder && this.encoder.state === "configured") {
      try {
        await this.encoder.flush();
      } catch {
        // Whatever the encoder still held is lost; the chunks so far are fine.
      }
      this.encoder.close();
    }
    this.chunker.flush();
    await this.context.close().catch(() => {});
  }
}

function createOpusEncoder(sampleRate: number, chunker: OpusChunker, onError?: (error: Error) => void) {
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      chunker.push(chunk.timestamp, packet);
    },
    error: (error) => onError?.(error instanceof Error ? error : new Error(String(error))),
  });
  encoder.configure(opusConfig(sampleRate));
  return encoder;
}
