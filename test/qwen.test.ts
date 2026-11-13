import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { createQwenProvider, normalizeThai } from "../src/server/transcription/qwen.ts";

/** A stand-in for DashScope's duplex inference endpoint, scripted per test. */
function fakeDashScope(script: (ws: { send(data: object): void; close(): void }, message: any) => void) {
  const received: { json: any[]; audioBytes: number; headers: Record<string, string> } = {
    json: [],
    audioBytes: 0,
    headers: {},
  };
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      received.headers = Object.fromEntries(req.headers);
      return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        if (typeof raw !== "string") {
          received.audioBytes += raw.byteLength;
          script({ send: (d) => ws.send(JSON.stringify(d)), close: () => ws.close() }, { audio: raw.byteLength });
          return;
        }
        const message = JSON.parse(raw);
        received.json.push(message);
        script({ send: (d) => ws.send(JSON.stringify(d)), close: () => ws.close() }, message);
      },
    },
  });
  servers.push(server);
  return { url: `ws://localhost:${server.port}/api-ws/v1/inference`, received };
}

const servers: Server<unknown>[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop(true)));

const event = (name: string, payload: object = {}) => ({ header: { task_id: "t", event: name }, payload });
const sentence = (s: object, usage?: object) => event("result-generated", { output: { sentence: s }, usage });

function provider(url: string) {
  return createQwenProvider({
    apiKey: "k",
    model: "qwen-audio-3.1-asr-flash-streaming",
    url,
    workspaceId: "ws1",
    languageHints: ["th", "en"],
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 2,
  });
}

test("speaks run-task: audio after task-started, sentences become segments, usage is billed as it grows", async () => {
  const { url, received } = fakeDashScope((ws, m) => {
    if (m.header?.action === "run-task") ws.send(event("task-started"));
    if (m.audio && received.audioBytes === 6400) {
      ws.send(sentence({ heartbeat: true, sentence_id: 0, text: "" }));
      ws.send(sentence({ sentence_id: 1, begin_time: 100, end_time: null, text: "สวัสดี", sentence_begin: true }));
      ws.send(
        sentence(
          { sentence_id: 1, begin_time: 100, end_time: 900, text: "สวัสดี Bun", sentence_end: true },
          { input_tokens: 40, output_tokens: 3 },
        ),
      );
    }
    if (m.header?.action === "finish-task") {
      ws.send(event("task-finished", { usage: { input_tokens: 85, output_tokens: 4 } }));
    }
  });
  const log: any[] = [];
  const closed = Promise.withResolvers<Error | undefined>();
  const session = provider(url).createSession({
    onPartial: (startMs, text) => log.push(["partial", startMs, text]),
    onSegment: (startMs, endMs, text) => log.push(["segment", startMs, endMs, text]),
    onUsage: (u) => log.push(["usage", u.inputTokens, u.outputTokens, u.costUsd]),
    onClose: closed.resolve,
  });
  // Sent before the task starts: must be held back, not dropped.
  session.sendAudio(new Uint8Array(3200));
  session.sendAudio(new Uint8Array(3200));
  await Bun.sleep(100);
  session.finish();
  expect(await closed.promise).toBeUndefined();

  const [runTask, finishTask] = received.json;
  expect(runTask.header).toMatchObject({ action: "run-task", streaming: "duplex" });
  expect(runTask.payload).toMatchObject({
    model: "qwen-audio-3.1-asr-flash-streaming",
    parameters: { format: "pcm", sample_rate: 16000, language_hints: ["th", "en"] },
  });
  expect(finishTask.header).toMatchObject({ action: "finish-task", task_id: runTask.header.task_id });
  expect(received.headers["authorization"]).toBe("Bearer k");
  expect(received.headers["x-dashscope-workspace"]).toBe("ws1");
  expect(log).toEqual([
    ["partial", 100, "สวัสดี"],
    ["usage", 40, 3, (40 * 1 + 3 * 2) / 1e6],
    ["segment", 100, 900, "สวัสดี Bun"],
    ["usage", 45, 1, (45 * 1 + 1 * 2) / 1e6],
  ]);
});

test("task-failed closes the session with the vendor's error", async () => {
  const { url } = fakeDashScope((ws, m) => {
    if (m.header?.action === "run-task") {
      ws.send({ header: { event: "task-failed", error_code: "InvalidApiKey", error_message: "bad key" }, payload: {} });
    }
  });
  const closed = Promise.withResolvers<Error | undefined>();
  provider(url).createSession({ onPartial() {}, onSegment() {}, onClose: closed.resolve });
  expect((await closed.promise)?.message).toBe("InvalidApiKey: bad key");
});

test("decomposed Thai SARA AM is composed", () => {
  expect(normalizeThai("นําไปสู่ ท้ําหมด ทํ้า")).toBe("นำไปสู่ ท้ำหมด ท้ำ");
  expect(normalizeThai("ดำรง")).toBe("ดำรง");
});
