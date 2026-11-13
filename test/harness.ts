import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app.ts";
import type { Publisher } from "../src/server/publisher.ts";
import { createFakeProvider } from "../src/server/transcription/fake.ts";
import {
  PCM_CHUNK_BYTES,
  encodeChunkFrame,
  type ClientMessage,
  type ServerMessage,
} from "../src/shared/protocol.ts";

export const MASTER = "master-secret";

export class FakePublisher implements Publisher {
  published: { channel: string; event: string; data: any }[] = [];
  async publish(channel: string, event: string, data: unknown) {
    this.published.push({ channel, event, data });
  }
}

/** A server on a temp data dir, restartable on the same dir. */
export class TestServer {
  readonly dataDir = mkdtempSync(join(tmpdir(), "live-speech-test-"));
  readonly publisher = new FakePublisher();
  app!: App;

  constructor() {
    this.start();
  }

  start() {
    this.app = startApp({
      port: 0,
      dataDir: this.dataDir,
      masterPassword: MASTER,
      // $3.60/h is $0.0001 per 100 ms chunk, which keeps cost assertions readable.
      provider: createFakeProvider({ pricePerHourUsd: 3.6 }),
      publisher: this.publisher,
      sockudoClient: null,
      transcriber: { catchUpSpeed: Infinity, idleMs: 50, retryMs: 50 },
      pingIntervalMs: 50,
    });
  }

  async restart() {
    await this.app.stop();
    this.start();
  }

  async dispose() {
    await this.app.stop();
    rmSync(this.dataDir, { recursive: true, force: true });
  }

  fetch(path: string, init: RequestInit & { auth?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.auth) headers.set("authorization", `Bearer ${init.auth}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(new URL(path, this.app.url), { ...init, headers });
  }

  async json<T = any>(path: string, init: RequestInit & { auth?: string } = {}): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async createRoom(name = "Test room") {
    return this.json<{ id: string; password: string }>("/api/admin/rooms", {
      method: "POST",
      auth: MASTER,
      body: JSON.stringify({ name }),
    });
  }

  /** Waits until transcription has caught up with all stored audio. */
  async settle() {
    await Bun.sleep(10);
    await this.app.transcriber.idle();
  }

  connectSender(roomId: string) {
    const url = new URL(`/api/rooms/${roomId}/ingest`, this.app.url);
    url.protocol = "ws:";
    return SenderClient.connect(url.toString());
  }
}

/** A minimal sender, speaking the ingest protocol directly. */
export class SenderClient {
  messages: ServerMessage[] = [];
  closed = false;
  private waiters: (() => void)[] = [];
  /** Monotonic ms since the stream's chunk 0, as the pong reports it. */
  elapsed = () => 0;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => {
      const message = JSON.parse(String(e.data)) as ServerMessage;
      this.messages.push(message);
      if (message.type === "ping") this.send({ type: "pong", id: message.id, elapsed: this.elapsed() });
      this.waiters.splice(0).forEach((w) => w());
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new SenderClient(ws);
  }

  send(message: ClientMessage) {
    this.ws.send(JSON.stringify(message));
  }

  sendChunk(seq: number, payload: Uint8Array) {
    this.ws.send(encodeChunkFrame(seq, payload) as Uint8Array<ArrayBuffer>);
  }

  async waitFor<T extends ServerMessage["type"]>(
    type: T,
    predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const found = this.messages.find(
        (m): m is Extract<ServerMessage, { type: T }> => m.type === type && predicate(m as any),
      );
      if (found) return found;
      if (this.closed) throw new Error(`Socket closed while waiting for ${type}`);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async hello(password: string, streamId: string, format: "pcm16" | "opus" = "pcm16") {
    this.send({ type: "hello", password, streamId, format });
    return (await this.waitFor("ready")).next;
  }

  close() {
    this.ws.close();
  }
}

/** A 100 ms PCM chunk filled with one sample value (0 = silence). */
export function pcmChunk(value: number) {
  const samples = new Int16Array(PCM_CHUNK_BYTES / 2).fill(value);
  return new Uint8Array(samples.buffer);
}

/** Chunks for a script like [1000, 1000, 0, 2000]: speech values and silences. */
export function script(values: number[]) {
  return values.map(pcmChunk);
}
