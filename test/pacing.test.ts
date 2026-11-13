import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/server/app.ts";
import { createNullPublisher } from "../src/server/publisher.ts";
import { encodeChunkFrame } from "../src/shared/protocol.ts";

/** Starts a server whose provider records when each chunk reaches it. */
async function setup(transcriber: { catchUpSpeed: number; idleMs: number }) {
  const dataDir = mkdtempSync(join(tmpdir(), "live-speech-pacing-"));
  const fedAt: number[] = [];
  const app = startApp({
    port: 0,
    dataDir,
    masterPassword: "m",
    publisher: createNullPublisher(),
    sockudoClient: null,
    transcriber: { ...transcriber, retryMs: 50 },
    provider: {
      name: "recorder",
      pricePerHourUsd: 0,
      createSession: () => ({
        sendAudio: () => void fedAt.push(performance.now()),
        finish() {},
        close() {},
      }),
    },
  });
  const room = app.rooms.createRoom("pacing");
  const url = new URL(`/api/rooms/${room.id}/ingest`, app.url);
  url.protocol = "ws:";
  const ws = new WebSocket(url);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.send(JSON.stringify({ type: "hello", password: room.password, streamId: "stream-pacing-1", format: "pcm16" }));
  await Bun.sleep(50);
  return {
    fedAt,
    send: (seq: number) => ws.send(encodeChunkFrame(seq, new Uint8Array(3200)) as Uint8Array<ArrayBuffer>),
    async dispose() {
      ws.close();
      await app.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("live audio reaches the provider promptly, not in idle-timer bursts", async () => {
  const s = await setup({ catchUpSpeed: 1.5, idleMs: 5000 });
  const sentAt: number[] = [];
  for (let i = 0; i < 15; i++) {
    sentAt.push(performance.now());
    s.send(i);
    await Bun.sleep(100);
  }
  await Bun.sleep(100);
  expect(s.fedAt).toHaveLength(15);
  const lags = s.fedAt.map((t, i) => t - sentAt[i]!);
  expect(Math.max(...lags)).toBeLessThan(80);
  await s.dispose();
});

test("a backlog is fed at catch-up speed, never as one big burst", async () => {
  const s = await setup({ catchUpSpeed: 2, idleMs: 5000 });
  // Arrives all at once, as after an outage: 6 s of audio.
  for (let i = 0; i < 60; i++) s.send(i);
  await Bun.sleep(300);
  // Within 300 ms at 2x: about 6 chunks plus the 2 s burst cap of 20.
  expect(s.fedAt.length).toBeLessThanOrEqual(28);
  expect(s.fedAt.length).toBeGreaterThan(3);
  await s.dispose();
});
