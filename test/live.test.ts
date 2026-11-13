import { afterEach, expect, test } from "bun:test";
import { LiveRoom } from "../src/web/live.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const snapshot = {
  room: { id: "r", name: "R", createdAt: 0 },
  transcript: { seq: 5, streams: {}, segments: {} },
  partials: [],
};

test("a partial older than the transcript is ignored, so finished text isn't shown twice", async () => {
  globalThis.fetch = (async () => Response.json(snapshot)) as unknown as typeof fetch;
  const live = new LiveRoom("r") as any;
  await live.loadSnapshot();
  // Catch-up over HTTP applies the final (seq 6) first…
  live.receiveEvent({
    type: "segment.final",
    seq: 6,
    at: 0,
    segmentId: "g1",
    streamId: "s",
    startMs: 0,
    endMs: 1000,
    text: "hello world",
    source: "asr",
  });
  // …then Sockudo delivers the partial that was published before it.
  live.receivePartial({ seq: 5, partial: { streamId: "s", startMs: 0, text: "hello wor" }, cleared: false });
  expect(Object.values(live.state.partials)).toEqual([]);
});

test("a failed config fetch (e.g. mid-redeploy) doesn't freeze the viewer", async () => {
  const calls: string[] = [];
  let configFails = true;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url) === "/api/config") {
      if (configFails) throw new TypeError("Failed to fetch");
      return Response.json({ sockudo: null });
    }
    if (String(url).includes("/events")) return Response.json({ events: [], seq: 5, partials: [] });
    return Response.json(snapshot);
  }) as unknown as typeof fetch;
  const live = new LiveRoom("r");
  await live.start();
  await Bun.sleep(1200);
  // It keeps catching up meanwhile…
  expect(calls.filter((c) => c.includes("/events")).length).toBeGreaterThan(0);
  configFails = false;
  await Bun.sleep(3000);
  // …and settles into a working mode once the config loads.
  expect(live.state.connection).toBe("polling");
  live.dispose();
}, 8000);

test("an event only replaces the segments it changes", async () => {
  const withSegment = {
    ...snapshot,
    transcript: {
      seq: 1,
      streams: {},
      segments: {
        a: { id: "a", streamId: "s", startMs: 0, endMs: 1, text: "one", versions: [], superseded: false },
        b: { id: "b", streamId: "s", startMs: 2, endMs: 3, text: "two", versions: [], superseded: false },
      },
    },
  };
  globalThis.fetch = (async () => Response.json(withSegment)) as unknown as typeof fetch;
  const live = new LiveRoom("r") as any;
  await live.loadSnapshot();
  const before = live.state.transcript.segments;
  live.receiveEvent({ type: "segment.edited", seq: 2, at: 0, segmentId: "b", text: "TWO", author: "x" });
  const after = live.state.transcript.segments;
  expect(after.a).toBe(before.a);
  expect(after.b).not.toBe(before.b);
  expect(after.b.text).toBe("TWO");
  expect(before.b.text).toBe("two");
});

test("custom CSS arrives as a room.style event", async () => {
  globalThis.fetch = (async () => Response.json(snapshot)) as unknown as typeof fetch;
  const live = new LiveRoom("r") as any;
  await live.loadSnapshot();
  live.receiveEvent({ type: "room.style", seq: 6, at: 0, css: "body { color: red }" });
  expect(live.state.transcript.css).toBe("body { color: red }");
});
