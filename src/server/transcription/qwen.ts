import type { TranscriptionProvider, TranscriptionSession, TranscriptionCallbacks } from "./provider.ts";

export interface QwenConfig {
  apiKey: string;
  model: string;
  /** Realtime endpoint, without the model query parameter. */
  url: string;
  /** Optional language hint such as "th"; omitted means auto-detect. */
  language?: string;
}

/**
 * Qwen3-ASR-Flash-Realtime over DashScope's OpenAI-style realtime protocol,
 * with the vendor's `server_vad` doing segmentation. The VAD events carry
 * `audio_start_ms` / `audio_end_ms`, which become the segment's offsets; the
 * transcript events carry no timestamps of their own.
 *
 * Prior art: the `qwen` adapter in vxasr (github.com/dtinth/vxbeamer), which
 * uses the same protocol with VAD turned off.
 */
export function createQwenProvider(config: QwenConfig): TranscriptionProvider {
  return {
    name: config.model,
    createSession(callbacks: TranscriptionCallbacks): TranscriptionSession {
      const ws = new WebSocket(`${config.url}?model=${encodeURIComponent(config.model)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}`, "OpenAI-Beta": "realtime=v1" },
      } as unknown as string[]);
      const queue: string[] = [];
      const items = new Map<string, { startMs: number; endMs: number | null; text: string }>();
      let open = false;
      let closed = false;
      let lastEndMs = 0;

      const send = (message: object) => {
        const data = JSON.stringify(message);
        if (open) ws.send(data);
        else queue.push(data);
      };
      const end = (error?: Error) => {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {}
        callbacks.onClose(error);
      };

      send({
        type: "session.update",
        session: {
          modalities: ["text"],
          input_audio_format: "pcm",
          sample_rate: 16000,
          input_audio_transcription: config.language ? { language: config.language } : {},
          turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 500 },
        },
      });

      ws.addEventListener("open", () => {
        open = true;
        for (const data of queue.splice(0)) ws.send(data);
      });
      ws.addEventListener("message", (e) => {
        if (closed) return;
        const data = JSON.parse(String(e.data));
        switch (data.type) {
          case "input_audio_buffer.speech_started":
            items.set(data.item_id, { startMs: data.audio_start_ms ?? lastEndMs, endMs: null, text: "" });
            break;
          case "input_audio_buffer.speech_stopped": {
            const item = items.get(data.item_id);
            if (item) item.endMs = data.audio_end_ms ?? null;
            if (typeof data.audio_end_ms === "number") lastEndMs = data.audio_end_ms;
            break;
          }
          case "conversation.item.input_audio_transcription.text": {
            let item = items.get(data.item_id);
            if (!item) items.set(data.item_id, (item = { startMs: lastEndMs, endMs: null, text: "" }));
            item.text = `${data.text ?? ""}${data.stash ?? ""}`;
            callbacks.onPartial(item.startMs, item.text);
            break;
          }
          case "conversation.item.input_audio_transcription.completed": {
            const item = items.get(data.item_id) ?? { startMs: lastEndMs, endMs: null, text: "" };
            items.delete(data.item_id);
            callbacks.onSegment(item.startMs, item.endMs ?? lastEndMs, data.transcript ?? "");
            break;
          }
          case "conversation.item.input_audio_transcription.failed":
            console.error("[qwen] transcription failed:", JSON.stringify(data));
            break;
          case "session.finished":
            end();
            break;
          case "error":
            end(new Error(JSON.stringify(data.error ?? data)));
            break;
        }
      });
      ws.addEventListener("error", () => end(new Error("WebSocket error")));
      ws.addEventListener("close", (e) => end(new Error(`WebSocket closed (${e.code} ${e.reason})`)));

      return {
        sendAudio(pcm) {
          if (closed) return;
          send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64") });
        },
        finish() {
          if (closed) return;
          // In VAD mode, closing without session.finish drops the item in progress.
          send({ type: "session.finish" });
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
