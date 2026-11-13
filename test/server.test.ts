import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MASTER, TestServer, pcmChunk, script } from "./harness.ts";

let server: TestServer;
beforeEach(() => {
  server = new TestServer();
});
afterEach(async () => {
  await server.dispose();
});

const STREAM = "stream-aaaaaaaa";

async function sendScript(roomId: string, password: string, values: number[], { streamId = STREAM, from = 0 } = {}) {
  const sender = await server.connectSender(roomId);
  await sender.hello(password, streamId);
  const chunks = script(values);
  chunks.forEach((c, i) => sender.sendChunk(from + i, c));
  await sender.waitFor("ack", (m) => m.next === from + chunks.length);
  return sender;
}

async function texts(roomId: string) {
  const t = await server.json(`/api/rooms/${roomId}/transcript.json`);
  return t.segments.map((s: { text: string }) => s.text);
}

describe("rooms and access", () => {
  test("creating a room needs the master password", async () => {
    const res = await server.fetch("/api/admin/rooms", { method: "POST", auth: "nope", body: '{"name":"x"}' });
    expect(res.status).toBe(401);
    const room = await server.createRoom("Talk");
    expect(room.password.length).toBeGreaterThan(10);
    const list = await server.json("/api/admin/rooms", { auth: MASTER });
    expect(list.map((r: { name: string }) => r.name)).toEqual(["Talk"]);
  });

  test("anyone can read a room; nobody learns its password from public endpoints", async () => {
    const room = await server.createRoom();
    const snapshot = await server.json(`/api/rooms/${room.id}`);
    expect(snapshot.room.id).toBe(room.id);
    expect(JSON.stringify(snapshot)).not.toContain(room.password);
  });

  test("the room password authenticates; regenerating it revokes the old one", async () => {
    const room = await server.createRoom();
    expect((await server.fetch(`/api/rooms/${room.id}/auth`, { method: "POST", auth: room.password })).status).toBe(
      200,
    );
    expect((await server.fetch(`/api/rooms/${room.id}/auth`, { method: "POST", auth: "wrong" })).status).toBe(401);
    const updated = await server.json(`/api/admin/rooms/${room.id}/password`, { method: "POST", auth: MASTER });
    expect((await server.fetch(`/api/rooms/${room.id}/auth`, { method: "POST", auth: room.password })).status).toBe(
      401,
    );
    expect((await server.fetch(`/api/rooms/${room.id}/auth`, { method: "POST", auth: updated.password })).status).toBe(
      200,
    );
  });

  test("a sender with the wrong password is turned away", async () => {
    const room = await server.createRoom();
    const sender = await server.connectSender(room.id);
    sender.send({ type: "hello", password: "wrong", streamId: STREAM, format: "pcm16" });
    expect((await sender.waitFor("error")).message).toContain("password");
  });
});

describe("audio ingest", () => {
  test("chunks are acknowledged and turned into transcript segments", async () => {
    const room = await server.createRoom();
    const sender = await sendScript(room.id, room.password, [1000, 1001, 0, 2000, 0]);
    sender.close();
    await server.settle();
    expect(await texts(room.id)).toEqual(["w1000 w1001", "w2000"]);
    const t = await server.json(`/api/rooms/${room.id}/transcript.json`);
    expect(t.segments[0]).toMatchObject({ startMs: 0, endMs: 200 });
    expect(t.segments[1]).toMatchObject({ startMs: 300, endMs: 400 });
  });

  test("a reconnecting sender is told where to resume, and duplicates are ignored", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 1001, 1002])).close();
    const sender = await server.connectSender(room.id);
    expect(await sender.hello(room.password, STREAM)).toBe(3);
    // Resend one already stored chunk, then continue.
    sender.sendChunk(2, pcmChunk(9999));
    sender.sendChunk(3, pcmChunk(1003));
    sender.sendChunk(4, pcmChunk(0));
    await sender.waitFor("ack", (m) => m.next === 5);
    sender.close();
    await server.settle();
    expect(await texts(room.id)).toEqual(["w1000 w1001 w1002 w1003"]);
  });

  test("a gap in chunk numbers is rejected", async () => {
    const room = await server.createRoom();
    const sender = await server.connectSender(room.id);
    await sender.hello(room.password, STREAM);
    sender.sendChunk(0, pcmChunk(1));
    sender.sendChunk(5, pcmChunk(1));
    expect((await sender.waitFor("error")).message).toContain("Gap");
  });

  test("the stored audio can be played back as WAV", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 2000, 3000])).close();
    const res = await server.fetch(`/api/rooms/${room.id}/streams/${STREAM}/audio.wav?from=100&to=300`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(bytes.byteLength).toBe(44 + 2 * 3200);
    expect(new DataView(bytes.buffer).getInt16(44, true)).toBe(2000);
  });

  test("a room can hold several streams", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0], { streamId: "stream-one-1111" })).close();
    (await sendScript(room.id, room.password, [2000, 0], { streamId: "stream-two-2222" })).close();
    await server.settle();
    expect((await texts(room.id)).sort()).toEqual(["w1000", "w2000"]);
    const rooms = await server.json("/api/admin/rooms", { auth: MASTER });
    expect(rooms[0].streams).toHaveLength(2);
  });
});

describe("clock sync", () => {
  test("the server places the stream on its own clock, ignoring the client's wall clock", async () => {
    const room = await server.createRoom();
    const sender = await server.connectSender(room.id);
    // The stream began 30 s ago according to the client's monotonic clock.
    const began = performance.now() - 30_000;
    sender.elapsed = () => performance.now() - began;
    await sender.hello(room.password, STREAM);
    await sender.waitFor("ping");
    await Bun.sleep(150);
    sender.close();
    const snapshot = await server.json(`/api/rooms/${room.id}`);
    const startedAt = snapshot.transcript.streams[STREAM].startedAt;
    expect(Math.abs(startedAt - (Date.now() - 30_000 - 150))).toBeLessThan(250);
  });
});

describe("transcript edits", () => {
  test("edits are append-only and can be reverted", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0])).close();
    await server.settle();
    const [segment] = (await server.json(`/api/rooms/${room.id}/transcript.json`)).segments;

    const unauth = await server.fetch(`/api/rooms/${room.id}/segments/${segment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ text: "hacked" }),
    });
    expect(unauth.status).toBe(401);

    const edited = await server.json(`/api/rooms/${room.id}/segments/${segment.id}`, {
      method: "PATCH",
      auth: room.password,
      body: JSON.stringify({ text: "Hello world", author: "agent" }),
    });
    expect(edited.text).toBe("Hello world");
    expect(edited.versions.map((v: { author: string }) => v.author)).toEqual(["fake", "agent"]);

    const reverted = await server.json(`/api/rooms/${room.id}/segments/${segment.id}`, {
      method: "PATCH",
      auth: room.password,
      body: JSON.stringify({ revertTo: edited.versions[0].seq }),
    });
    expect(reverted.text).toBe("w1000");
    expect(reverted.versions).toHaveLength(3);
  });
});

describe("live updates", () => {
  test("events are published in order with sequence numbers, and can be fetched since a seq", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0, 2000, 0])).close();
    await server.settle();
    await server.app.rooms.flushPublishes();
    const events = server.publisher.published.filter((p) => p.event === "event").map((p) => p.data.event);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(server.publisher.published.every((p) => p.channel === `room-${room.id}`)).toBe(true);
    expect(server.publisher.published.some((p) => p.event === "partial")).toBe(true);

    const since = await server.json(`/api/rooms/${room.id}/events?after=1`);
    expect(since.events.map((e: { seq: number }) => e.seq)).toEqual(events.slice(1).map((e) => e.seq));
  });

  test("the plain-text transcript is ready for agents", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0, 2000, 0])).close();
    await server.settle();
    const res = await server.fetch(`/api/rooms/${room.id}/transcript.txt`);
    expect(await res.text()).toBe("w1000\nw2000");
  });
});

describe("robustness", () => {
  test("a restart loses nothing, and untranscribed audio is transcribed after it", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0])).close();
    await server.settle();
    // Stop transcription so the next audio is stored but not transcribed.
    server.app.transcriber.stop();
    (await sendScript(room.id, room.password, [2000, 2001, 0], { from: 2 })).close();
    await server.restart();
    await server.settle();
    expect(await texts(room.id)).toEqual(["w1000", "w2000 w2001"]);
    const sender = await server.connectSender(room.id);
    expect(await sender.hello(room.password, STREAM)).toBe(5);
    sender.close();
  });

  test("deleting a room removes it and its audio", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0])).close();
    const res = await server.fetch(`/api/admin/rooms/${room.id}/export`, { auth: MASTER });
    const exportPath = join(server.dataDir, "export.sqlite");
    await Bun.write(exportPath, await res.arrayBuffer());
    const exported = new Database(exportPath, { readonly: true });
    expect(exported.query("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 2 });
    expect((exported.query("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBeGreaterThan(0);
    expect(exported.query("SELECT name FROM rooms").all()).toEqual([{ name: "Test room" }]);
    exported.close();
    await server.json(`/api/admin/rooms/${room.id}`, { method: "DELETE", auth: MASTER });
    expect((await server.fetch(`/api/rooms/${room.id}`)).status).toBe(404);
    expect((await server.fetch(`/api/rooms/${room.id}/streams/${STREAM}/audio.wav`)).status).toBe(404);
    const db = new Database(join(server.dataDir, "live-speech.sqlite"), { readonly: true });
    expect(db.query("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
    db.close();
  });

  test("the cost of transcription is tracked per stream and survives export", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 1001, 0, 0, 2000, 0])).close();
    await server.settle();
    const [admin] = await server.json("/api/admin/rooms", { auth: MASTER });
    expect(admin.usage.audioMs).toBe(600);
    expect(admin.usage.costUsd).toBeCloseTo(0.0006, 10);
    expect(admin.usage.byStream).toEqual([
      { streamId: STREAM, model: "fake", audioMs: 600, sessions: 1, costUsd: expect.closeTo(0.0006, 10) },
    ]);
    expect(admin.streams[0].costUsd).toBeCloseTo(0.0006, 10);

    const res = await server.fetch(`/api/admin/rooms/${room.id}/export`, { auth: MASTER });
    const exportPath = join(server.dataDir, "export.sqlite");
    await Bun.write(exportPath, await res.arrayBuffer());
    const exported = new Database(exportPath, { readonly: true });
    expect(exported.query("SELECT model, audio_ms FROM usage").all()).toEqual([{ model: "fake", audio_ms: 600 }]);
    exported.close();
  });

  test("usage adds up across sessions instead of being replaced", async () => {
    const room = await server.createRoom();
    (await sendScript(room.id, room.password, [1000, 0])).close();
    await server.settle();
    // As when the same audio is fed again after a vendor error.
    server.app.rooms.addUsage(STREAM, "fake", { audioMs: 200, sessions: 1, costUsd: 0.0002 });
    const [admin] = await server.json("/api/admin/rooms", { auth: MASTER });
    expect(admin.usage.byStream[0]).toMatchObject({ audioMs: 400, sessions: 2 });
  });

  test("deleting a room while it is being transcribed stops cleanly", async () => {
    const room = await server.createRoom();
    const sender = await sendScript(room.id, room.password, [1000, 1001, 1002]);
    await server.json(`/api/admin/rooms/${room.id}`, { method: "DELETE", auth: MASTER });
    sender.close();
    await server.settle();
    expect((await server.json("/api/admin/rooms", { auth: MASTER })).length).toBe(0);
  });
});

describe("hostile input", () => {
  test("malformed sender messages are rejected without taking the server down", async () => {
    const room = await server.createRoom();
    const attempts: ((s: Awaited<ReturnType<typeof server.connectSender>>) => void)[] = [
      (s) => s.ws.send("null"),
      (s) => s.ws.send("42"),
      (s) => s.ws.send(JSON.stringify({ type: "hello", streamId: STREAM, format: "pcm16" })),
      (s) => s.ws.send(JSON.stringify({ type: "hello", password: room.password, streamId: 7, format: "pcm16" })),
      (s) => s.ws.send(new Uint8Array([1])),
    ];
    for (const attempt of attempts) {
      const sender = await server.connectSender(room.id);
      attempt(sender);
      await sender.waitFor("error").catch(() => {});
    }
    // A short binary frame after a valid hello.
    const sender = await server.connectSender(room.id);
    await sender.hello(room.password, STREAM);
    sender.ws.send(new Uint8Array([1, 2]));
    await sender.waitFor("error");
    expect((await server.fetch("/api/health")).status).toBe(200);
  });

  test("a second hello on the same connection is refused", async () => {
    const room = await server.createRoom();
    const sender = await server.connectSender(room.id);
    await sender.hello(room.password, STREAM);
    sender.send({ type: "hello", password: room.password, streamId: "stream-bbbbbbbb", format: "pcm16" });
    expect((await sender.waitFor("error")).message).toContain("hello");
  });

  test("regenerating the room password cuts off connected senders", async () => {
    const room = await server.createRoom();
    const sender = await server.connectSender(room.id);
    await sender.hello(room.password, STREAM);
    await server.json(`/api/admin/rooms/${room.id}/password`, { method: "POST", auth: MASTER });
    expect((await sender.waitFor("error")).message).toContain("password");
  });

  test("segment ids that name built-in properties are not segments", async () => {
    const room = await server.createRoom();
    for (const id of ["__proto__", "hasOwnProperty", "constructor"]) {
      expect((await server.fetch(`/api/rooms/${room.id}/segments/${id}`)).status).toBe(404);
      const res = await server.fetch(`/api/rooms/${room.id}/segments/${id}`, {
        method: "PATCH",
        auth: room.password,
        body: JSON.stringify({ text: "junk" }),
      });
      expect(res.status).toBe(404);
    }
    const events = await server.json(`/api/rooms/${room.id}/events?after=0`);
    expect(events.events).toHaveLength(0);
  });
});
