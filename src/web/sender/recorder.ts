/**
 * Microphone → AudioWorklet → (Opus encoder | 16 kHz PCM) → 100 ms chunks.
 *
 * A stream's timing comes from chunk numbers alone (chunk n starts n × 100 ms
 * after chunk 0), so captured samples must keep pace with real time. If audio
 * stops arriving for a while (the AudioContext gets suspended, the track is
 * muted or stalls), the sample clock falls behind and everything after the
 * gap would land too early. When that happens the recorder ends the current
 * *segment* and starts a new one (fresh seq 0, fresh clock) with the next
 * audio that arrives; the caller uploads each segment as its own stream.
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
  /** A new segment begins; its chunks follow, numbered from 0. Segment 0 begins with the first audio. */
  onSegmentStart(segment: number): void;
  onChunk(segment: number, seq: number, payload: Uint8Array): void;
  /** Every chunk of the segment has been emitted. */
  onSegmentEnd(segment: number): void;
  /** Peak level (0–1) of each captured block, for a meter. */
  onLevel?(peak: number): void;
  /** The input is gone for good (device unplugged, permission revoked). Recording has stopped. */
  onEnded?(error: Error): void;
  /** Something worth showing that recording survives (encoder error, suspension); null clears it. */
  onWarning?(message: string | null): void;
  /** How far the sample clock may fall behind real time before a new segment starts. */
  maxDriftMs?: number;
}

const OPUS_BITRATE = 32_000;
const OPUS_FRAME_US = 20_000;
const DRIFT_CHECK_MS = 250;

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

/** One unbroken run of samples, uploaded as one stream. */
interface Segment {
  index: number;
  /** performance.now() when its chunk 0 began. */
  startedAt: number;
  /** Samples captured in this segment: its own clock. */
  samples: number;
  /** Slow, steady clock drift already accounted for, in ms (see checkDrift). */
  baselineLag: number;
  chunker: OpusChunker | Pcm16Chunker;
  encoder: AudioEncoder | null;
}

export class Recorder {
  readonly format: AudioFormat;
  private stopped = false;
  private segment: Segment | null = null;
  private nextSegment = 0;
  /** Segment start times, kept so `elapsed` works for a segment still uploading after it ended. */
  private starts = new Map<number, number>();
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive drift checks over the limit; one alone may be a busy main thread. */
  private lateChecks = 0;
  private ending: Promise<void> = Promise.resolve();

  private constructor(
    format: AudioFormat,
    private context: AudioContext,
    private media: MediaStream,
    private source: MediaStreamAudioSourceNode,
    private node: AudioWorkletNode,
    private options: RecorderOptions,
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
      const format = options.format ?? ((await canEncodeOpus(context.sampleRate)) ? "opus" : "pcm16");

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
      const recorder = new Recorder(format, context, media, source, node, options);
      recorder.wire();
      source.connect(node);
      if (context.state === "suspended") await context.resume();
      return recorder;
    } catch (error) {
      media.getTracks().forEach((t) => t.stop());
      await context?.close().catch(() => {});
      throw error;
    }
  }

  private get sampleRate() {
    return this.context.sampleRate;
  }

  private wire() {
    const { options } = this;
    this.node.port.onmessage = (e: MessageEvent<Float32Array<ArrayBuffer>>) => this.capture(e.data);

    // Browsers suspend or interrupt audio (OS audio session changes, power
    // saving); try to get it back. Any gap this leaves is handled by the drift check.
    this.context.addEventListener("statechange", () => {
      if (this.stopped) return;
      const state = this.context.state as string;
      if (state === "suspended" || state === "interrupted") {
        options.onWarning?.(`Audio capture was ${state} by the browser; trying to resume`);
        this.context.resume().catch(() => {});
      }
    });

    const track = this.media.getAudioTracks()[0];
    track?.addEventListener("mute", () => options.onWarning?.("The audio input is muted by the system or device"));
    track?.addEventListener("unmute", () => options.onWarning?.(null));
    track?.addEventListener("ended", () => {
      if (this.stopped) return;
      void this.stop().then(() =>
        options.onEnded?.(new Error("The audio input stopped (device unplugged or permission revoked)")),
      );
    });

    this.driftTimer = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS);
  }

  private capture(block: Float32Array<ArrayBuffer>) {
    if (this.stopped) return;
    const { options } = this;
    let segment = this.segment;
    if (!segment) segment = this.segment = this.beginSegment(block.length);

    let peak = 0;
    for (let i = 0; i < block.length; i++) peak = Math.max(peak, Math.abs(block[i]!));
    options.onLevel?.(peak);

    const { chunker } = segment;
    if (chunker instanceof Pcm16Chunker) {
      chunker.push(block);
    } else {
      if (!segment.encoder || segment.encoder.state === "closed") {
        // The encoder died (e.g. reclaimed by the browser). Start a fresh one;
        // timestamps keep counting, so chunks stay aligned.
        segment.encoder = this.createEncoder(chunker);
      }
      const data = new AudioData({
        format: "f32",
        sampleRate: this.sampleRate,
        numberOfFrames: block.length,
        numberOfChannels: 1,
        timestamp: Math.round((segment.samples / this.sampleRate) * 1e6),
        data: block,
      });
      segment.encoder.encode(data);
      data.close();
    }
    segment.samples += block.length;
  }

  private beginSegment(firstBlockLength: number): Segment {
    const index = this.nextSegment++;
    // The block's first sample was captured about one block earlier.
    const startedAt = performance.now() - (firstBlockLength / this.sampleRate) * 1000;
    this.starts.set(index, startedAt);
    this.lateChecks = 0;
    this.options.onSegmentStart(index);
    const emit = (seq: number, payload: Uint8Array) => this.options.onChunk(index, seq, payload);
    if (this.format === "opus") {
      const chunker = new OpusChunker(emit);
      return { index, startedAt, samples: 0, baselineLag: 0, chunker, encoder: this.createEncoder(chunker) };
    }
    return { index, startedAt, samples: 0, baselineLag: 0, chunker: new Pcm16Chunker(this.sampleRate, emit), encoder: null };
  }

  /** How far the current segment's sample clock is behind real time, in ms. */
  private drift(segment: Segment) {
    return performance.now() - segment.startedAt - (segment.samples / this.sampleRate) * 1000;
  }

  private checkDrift() {
    const segment = this.segment;
    if (!segment || this.stopped) return;
    const limit = this.options.maxDriftMs ?? 300;
    // A sound card clock a few ppm off the system clock drifts slowly but
    // steadily (50 ppm is 300 ms in under 2 h). Follow that slow drift and
    // react only to a sudden stall, so an all-day stream isn't split for it.
    const lag = this.drift(segment) - segment.baselineLag;
    if (Math.abs(lag) < limit / 3) segment.baselineLag += lag * 0.05;
    this.lateChecks = lag > limit ? this.lateChecks + 1 : 0;
    // Two checks in a row: a single late one can be a busy main thread
    // delivering queued blocks late, which catches up by itself.
    if (this.lateChecks >= 2) {
      this.options.onWarning?.(
        `Audio stopped arriving for ${Math.round(this.drift(segment) - segment.baselineLag)} ms; continuing as a new stream so the timing stays true`,
      );
      this.endSegment();
    }
  }

  /** Ends the current segment; the next audio that arrives starts a new one. */
  private endSegment() {
    const segment = this.segment;
    if (!segment) return this.ending;
    this.segment = null;
    this.lateChecks = 0;
    const done = this.ending.then(async () => {
      if (segment.encoder && segment.encoder.state === "configured") {
        try {
          await segment.encoder.flush();
        } catch {
          // Whatever the encoder still held is lost; the chunks so far are fine.
        }
        segment.encoder.close();
      }
      segment.chunker.flush();
      this.options.onSegmentEnd(segment.index);
    });
    this.ending = done;
    return done;
  }

  /** Milliseconds since chunk 0 of `segment` began, on this page's monotonic clock. */
  elapsed(segment: number): number {
    const startedAt = this.starts.get(segment);
    return startedAt === undefined ? 0 : performance.now() - startedAt;
  }

  /** Stops capture and emits the final chunk(s) of the last segment. */
  async stop() {
    if (this.stopped) return this.ending;
    this.stopped = true;
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.source.disconnect();
    this.node.port.onmessage = null;
    this.media.getTracks().forEach((t) => t.stop());
    await this.endSegment();
    await this.context.close().catch(() => {});
  }

  private createEncoder(chunker: OpusChunker) {
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        chunker.push(chunk.timestamp, packet);
      },
      error: (error) => this.options.onWarning?.(`Opus encoder error: ${error.message}`),
    });
    encoder.configure(opusConfig(this.sampleRate));
    return encoder;
  }
}
