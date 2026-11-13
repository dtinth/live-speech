import type { TranscriptionProvider, TranscriptionSession, TranscriptionCallbacks } from "./provider.ts";

export interface QwenConfig {
  apiKey: string;
  /** e.g. qwen-audio-3.1-asr-flash-streaming */
  model: string;
  /** Duplex inference endpoint, e.g. wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference */
  url: string;
  /** Sent as X-DashScope-WorkSpace when set. */
  workspaceId?: string;
  /** Language hints such as ["th", "en"] (up to 4); empty means auto-detect. */
  languageHints: string[];
  /** USD per million tokens, as billed for qwen-audio-3.1-asr-flash-streaming. */
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/**
 * Qwen-Audio-ASR-Streaming (qwen-audio-3.1-asr-flash-streaming) over
 * DashScope's duplex `run-task` protocol. The vendor's VAD splits speech into
 * sentences; each result carries `begin_time` / `end_time` in ms from the
 * start of the task, which become the segment's offsets.
 *
 * Docs: https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-websocket-api
 */
export function createQwenProvider(config: QwenConfig): TranscriptionProvider {
  return {
    name: config.model,
    // The vendor reports token usage as it goes; nothing to estimate.
    pricePerHourUsd: 0,
    reportsUsage: true,
    createSession(callbacks: TranscriptionCallbacks): TranscriptionSession {
      const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
      if (config.workspaceId) headers["X-DashScope-WorkSpace"] = config.workspaceId;
      const ws = new WebSocket(config.url, { headers } as unknown as string[]);
      ws.binaryType = "arraybuffer";
      const taskId = crypto.randomUUID();
      const queue: Uint8Array<ArrayBuffer>[] = [];
      let started = false;
      let finishRequested = false;
      let closed = false;
      const billed = { input: 0, output: 0 };

      const command = (action: "run-task" | "finish-task", payload: object) =>
        ws.send(JSON.stringify({ header: { action, task_id: taskId, streaming: "duplex" }, payload }));
      const sendFinish = () => command("finish-task", { input: {} });
      const end = (error?: Error) => {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {}
        callbacks.onClose(error);
      };
      /** Usage is cumulative per task; report what is new since last time. */
      const recordUsage = (usage: { input_tokens?: number; output_tokens?: number } | undefined) => {
        if (!usage || typeof usage.input_tokens !== "number") return;
        const input = usage.input_tokens - billed.input;
        const output = (usage.output_tokens ?? 0) - billed.output;
        if (input <= 0 && output <= 0) return;
        billed.input = usage.input_tokens;
        billed.output = usage.output_tokens ?? 0;
        callbacks.onUsage?.({
          inputTokens: input,
          outputTokens: output,
          costUsd: (input * config.inputPerMillionUsd + output * config.outputPerMillionUsd) / 1_000_000,
        });
      };

      ws.addEventListener("open", () => {
        const parameters: Record<string, unknown> = {
          format: "pcm",
          sample_rate: 16000,
          // Captions read better in shorter sentences than the 800 ms default gives.
          max_sentence_silence: 500,
          // Keep the task alive through pauses between talks.
          heartbeat: true,
        };
        if (config.languageHints.length) parameters.language_hints = config.languageHints;
        command("run-task", {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: config.model,
          parameters,
          input: {},
        });
      });
      ws.addEventListener("message", (e) => {
        if (closed || typeof e.data !== "string") return;
        let data;
        try {
          data = JSON.parse(e.data);
        } catch {
          console.error("[qwen] non-JSON message:", e.data.slice(0, 200));
          return;
        }
        switch (data.header?.event) {
          case "task-started":
            started = true;
            for (const pcm of queue.splice(0)) ws.send(pcm);
            if (finishRequested) sendFinish();
            break;
          case "result-generated": {
            recordUsage(data.payload?.usage);
            const sentence = data.payload?.output?.sentence;
            if (!sentence || sentence.heartbeat) break;
            const startMs = Number(sentence.begin_time ?? 0);
            if (sentence.sentence_end) {
              callbacks.onSegment(startMs, Number(sentence.end_time ?? startMs), String(sentence.text ?? ""));
            } else {
              callbacks.onPartial(startMs, String(sentence.text ?? ""));
            }
            break;
          }
          case "task-finished":
            recordUsage(data.payload?.usage);
            end();
            break;
          case "task-failed":
            end(new Error(`${data.header.error_code}: ${data.header.error_message}`));
            break;
        }
      });
      ws.addEventListener("error", () => end(new Error("WebSocket error")));
      ws.addEventListener("close", (e) => end(new Error(`WebSocket closed (${e.code} ${e.reason})`)));

      return {
        sendAudio(pcm) {
          if (closed) return;
          // Copy: the caller may reuse its buffer, and queued audio waits for task-started.
          const frame = new Uint8Array(pcm);
          if (started) ws.send(frame);
          else queue.push(frame);
        },
        finish() {
          if (closed || finishRequested) return;
          finishRequested = true;
          // Results for the sentence in progress still arrive, then task-finished.
          if (started) sendFinish();
        },
        close() {
          closed = true;
          try {
            ws.close();
          } catch {}
        },
      };
    },
  };
}
