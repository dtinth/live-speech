import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CHUNK_MS } from "../shared/protocol.ts";
import {
  applyEvent,
  orderedSegments,
  type LivePartial,
  type RoomEvent,
  type TranscriptState,
} from "../shared/transcript.ts";
import { IndexedDbChunkStore, type ChunkStore, type StoredStream } from "./sender/chunkStore.ts";
import { Recorder, listInputDevices } from "./sender/recorder.ts";
import {
  StreamUploader,
  randomStreamId,
  storageWarning,
  webSocketFactory,
  type UploaderStatus,
} from "./sender/uploader.ts";

const roomId = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const passwordKey = `live-speech:room-password:${roomId}`;
const deviceKey = "live-speech:input-device";
/** Pause the transcript preview while this much audio is waiting to upload, to leave the link to the audio. */
const PREVIEW_PAUSE_CHUNKS = 2000 / CHUNK_MS;

// localStorage can throw (private mode, blocked storage); remembering things is only a convenience.
function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}
function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function ingestUrl() {
  const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/ingest`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Holds a Web Lock named after the stream until `until` settles, so two tabs
 * never upload the same stream and a tab can tell a crashed tab's stream (lock
 * free) from one another tab is still recording (lock held).
 * Calls `run` only if the lock was obtained. Resolves (with whether it was)
 * as soon as that is known, not when `run` finishes.
 */
function withStreamLock(streamId: string, wait: boolean, run: () => Promise<void>): Promise<boolean> {
  const name = `live-speech-stream:${streamId}`;
  if (!navigator.locks) {
    void run();
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(name, { ifAvailable: !wait }, async (lock) => {
        resolve(lock !== null);
        if (lock) await run();
      })
      .catch(reject);
  });
}

async function checkPassword(password: string): Promise<boolean> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/auth`, {
    method: "POST",
    headers: { authorization: `Bearer ${password}` },
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  return true;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function stateBadge(status: UploaderStatus | null) {
  if (!status) return <span className="badge">Idle</span>;
  switch (status.state) {
    case "connected":
      return <span className="badge ok">Connected</span>;
    case "connecting":
      return <span className="badge warn">Connecting…</span>;
    case "backoff":
      return <span className="badge bad">Offline, retrying</span>;
    case "unauthorized":
      return <span className="badge bad">Password rejected</span>;
    case "gone":
      return <span className="badge bad">Room gone</span>;
    case "done":
      return <span className="badge ok">Finished</span>;
  }
}

/** Re-renders every `ms` while mounted; uploader and recorder state lives outside React. */
function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

function App() {
  const [roomName, setRoomName] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [store, setStore] = useState<ChunkStore | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [backlog, setBacklog] = useState(0);

  useEffect(() => {
    fetch(`/api/rooms/${encodeURIComponent(roomId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "No such room" : `Server answered ${res.status}`);
        setRoomName((await res.json()).room.name);
      })
      .catch((e) => setRoomError((e as Error).message));
    IndexedDbChunkStore.open()
      .then(setStore)
      .catch((e) => setStoreError(`IndexedDB is unavailable: ${(e as Error).message}`));
    const saved = recall(passwordKey);
    if (saved) {
      checkPassword(saved)
        .then((ok) => (ok ? setPassword(saved) : remember(passwordKey, null)))
        .catch(() => setPassword(saved)); // Offline: trust it; the ingest socket will check again.
    }
  }, []);

  const authenticated = (value: string) => {
    remember(passwordKey, value);
    setPassword(value);
  };

  return (
    <main>
      <h1>Send audio</h1>
      <p className="muted">
        {roomName ?? roomId}
        {" · "}
        <a href={`/rooms/${encodeURIComponent(roomId)}`}>viewer</a>
      </p>
      {roomError && <p className="error">{roomError}</p>}
      {storeError && <p className="error">{storeError}</p>}
      {password === null ? (
        <PasswordForm onAuthenticated={authenticated} />
      ) : store ? (
        <Sender
          store={store}
          password={password}
          onPassword={authenticated}
          onForget={(active) => {
            remember(passwordKey, null);
            // While audio is recording or uploading, keep using it in this tab; it just isn't stored any more.
            if (!active) setPassword(null);
          }}
          onBacklog={setBacklog}
        />
      ) : (
        !storeError && <p className="muted">Opening local storage…</p>
      )}
      <TranscriptPreview paused={backlog > PREVIEW_PAUSE_CHUNKS} />
    </main>
  );
}

function PasswordForm({ onAuthenticated, prompt }: { onAuthenticated(password: string): void; prompt?: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (await checkPassword(value)) {
            onAuthenticated(value);
            setValue("");
          } else {
            setError("Wrong room password");
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {prompt && <p className="sender-warning">{prompt}</p>}
      <label htmlFor="password">Room password</label>
      <div className="row">
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="primary" disabled={busy || !value}>
          Continue
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

interface Live {
  recorder: Recorder;
  /** Local stream id of the segment being recorded now. */
  current: string | null;
}

function Sender({
  store,
  password,
  onPassword,
  onForget,
  onBacklog,
}: {
  store: ChunkStore;
  password: string;
  onPassword(password: string): void;
  onForget(active: boolean): void;
  onBacklog(chunks: number): void;
}) {
  useTick(250);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => recall(deviceKey) ?? "");
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const live = useRef<Live | null>(null);
  /** Every stream uploading from this tab, by local id: the live one, finished segments, leftovers from earlier loads. */
  const uploaders = useRef(new Map<string, StreamUploader>());
  const passwordRef = useRef(password);
  const level = useRef(0);
  const shownLevel = useRef(0);

  // A new password (after a rotation) goes to every running upload.
  useEffect(() => {
    passwordRef.current = password;
    for (const uploader of uploaders.current.values()) uploader.setPassword(password);
  }, [password]);

  const refreshDevices = useCallback(() => {
    listInputDevices().then(setDevices, () => {});
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  useEffect(() => {
    if (!navigator.storage?.estimate) return;
    const update = () => {
      navigator.storage.estimate().then(setEstimate, () => {});
      navigator.storage.persisted?.().then(setPersisted, () => {});
    };
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, []);

  const startUploader = async (stream: StoredStream, elapsed: (() => number) | null) => {
    const uploader = await StreamUploader.start({
      store,
      stream,
      connect: webSocketFactory(ingestUrl()),
      password: passwordRef.current,
      elapsed,
    });
    uploaders.current.set(stream.id, uploader);
    return uploader;
  };

  // Resume unfinished streams for this room: ones left by a reload or crash.
  useEffect(() => {
    let cancelled = false;
    const scan = async () => {
      for (const stream of await store.listStreams()) {
        if (cancelled) return;
        if (stream.roomId !== roomId || uploaders.current.has(stream.id)) continue;
        // Skips streams another open tab still holds (it is recording or uploading them).
        void withStreamLock(stream.id, false, async () => {
          if (cancelled || uploaders.current.has(stream.id)) return;
          // Its start isn't on this page's clock, so leave clock sync alone.
          const uploader = await startUploader({ ...stream, stopped: true }, null);
          await uploader.finish();
        });
      }
    };
    scan().catch((e) => setError(`Could not read local backlog: ${(e as Error).message}`));
    // Look again now and then: a tab that crashed after this one loaded leaves a stream behind too.
    const timer = setInterval(() => scan().catch(() => {}), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [store]);

  // Warn before leaving while anything is recording or unsent. (The backlog would survive, but only resume when the page is reopened.)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const pending = [...uploaders.current.values()].some((u) => u.status().state !== "done");
      if (live.current || pending) e.preventDefault();
    };
    addEventListener("beforeunload", handler);
    return () => removeEventListener("beforeunload", handler);
  }, []);

  /** Stops recording (the streams finish uploading in the background). */
  const stop = async () => {
    const current = live.current;
    if (!current) return;
    live.current = null;
    await current.recorder.stop();
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    setWarning(null);
    // Ask for persistent storage so the browser won't evict an unsent backlog under pressure.
    navigator.storage?.persist?.().then(setPersisted, () => {});

    let recorder: Recorder | null = null;
    let resolveRecorder!: (recorder: Recorder) => void;
    const recorderReady = new Promise<Recorder>((resolve) => (resolveRecorder = resolve));
    const fail = (message: string) => {
      setError(message);
      void stop();
      void recorder?.stop();
    };

    /**
     * Where one segment's chunks go. Recording doesn't wait for any of this:
     * chunks that arrive before the uploader exists queue in `early`.
     */
    let currentStream: string | null = null;
    const segments = new Map<number, { early: [number, Uint8Array][]; uploader: StreamUploader | null; ended: boolean }>();
    const save = (uploader: StreamUploader, seq: number, payload: Uint8Array) =>
      uploader.addChunk(seq, payload).catch((e) => fail(`Could not record audio: ${(e as Error).message}`));

    const openSegment = (segment: number) => {
      const sink = { early: [] as [number, Uint8Array][], uploader: null as StreamUploader | null, ended: false };
      segments.set(segment, sink);
      const streamId = randomStreamId();
      currentStream = streamId;
      if (live.current?.recorder === recorder) live.current.current = streamId;
      void (async () => {
        const rec = await recorderReady;
        let releaseLock!: () => void;
        const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
        try {
          await withStreamLock(streamId, true, () => lockReleased);
          const stream: StoredStream = { id: streamId, roomId, format: rec.format, createdAt: Date.now(), stopped: false };
          const uploader = await startUploader(stream, () => rec.elapsed(segment));
          void uploader.whenDone().then(releaseLock);
          sink.uploader = uploader;
          for (const [seq, payload] of sink.early.splice(0)) void save(uploader, seq, payload);
          if (sink.ended) void uploader.finish();
        } catch (e) {
          releaseLock();
          fail(`Could not set up local storage for recording: ${(e as Error).message}`);
        }
      })();
    };

    try {
      // Recording starts here, before anything touches the network.
      recorder = await Recorder.start({
        deviceId: deviceId || undefined,
        processing,
        onSegmentStart: openSegment,
        onChunk: (segment, seq, payload) => {
          const sink = segments.get(segment);
          if (!sink) return;
          if (sink.uploader) void save(sink.uploader, seq, payload);
          else sink.early.push([seq, payload]);
        },
        onSegmentEnd: (segment) => {
          const sink = segments.get(segment);
          if (!sink) return;
          sink.ended = true;
          // addChunk calls are queued in order, so finishing after them uploads every chunk first.
          if (sink.uploader) void sink.uploader.finish();
        },
        onLevel: (peak) => (level.current = Math.max(level.current, peak)),
        onWarning: setWarning,
        onEnded: (e) => {
          live.current = null;
          setError(`${e.message}. Recording stopped; what was recorded is still being uploaded. Press Start to record again.`);
        },
      });
      live.current = { recorder, current: currentStream };
      resolveRecorder(recorder);
      refreshDevices(); // Labels become available once permission is granted.
    } catch (e) {
      // Don't leave the mic on if anything after getUserMedia failed.
      await recorder?.stop();
      live.current = null;
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const all = [...uploaders.current.values()];
  const currentId = live.current?.current ?? null;
  const current = currentId ? (uploaders.current.get(currentId) ?? null) : null;
  const status = current?.status() ?? null;
  const others = all.filter((u) => u !== current).map((u) => u.status()).filter((s) => s.state !== "done");
  const statuses = [...(status ? [status] : []), ...others];
  const backlogChunks = statuses.reduce((n, s) => n + s.backlogChunks, 0);
  const backlogBytes = statuses.reduce((n, s) => n + s.backlogBytes, 0);
  const quota = storageWarning(estimate);
  const unauthorized = statuses.some((s) => s.state === "unauthorized");
  const storageError = statuses.find((s) => s.storageError)?.storageError;

  useEffect(() => onBacklog(backlogChunks));

  // A room deleted mid-recording: there is nowhere to send audio any more.
  const roomGone = status?.state === "gone";
  useEffect(() => {
    if (roomGone && live.current) {
      void stop();
      setError("This room no longer exists on the server. Recording stopped.");
    }
  }, [roomGone]);

  // Show the loudest peak since the last render, falling back gently so short sounds stay visible.
  const peak = Math.max(level.current, shownLevel.current * 0.6);
  shownLevel.current = peak;
  level.current = 0;
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const meter = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const active = !!live.current || others.length > 0;

  return (
    <>
      {unauthorized && (
        <PasswordForm
          prompt="The server rejected the room password (it may have been changed). Recording continues and is kept locally; enter the new password to resume uploading."
          onAuthenticated={onPassword}
        />
      )}
      <section className="card">
        <div className="row spread">
          <div className="row">
            {live.current ? (
              <button className="danger" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="primary" onClick={start} disabled={starting}>
                {starting ? "Starting…" : "Start"}
              </button>
            )}
            {stateBadge(status)}
            {live.current && <span className="badge bad sender-rec">● REC</span>}
          </div>
          <div className="row">
            <select
              aria-label="Input device"
              value={deviceId}
              disabled={!!live.current}
              onChange={(e) => {
                setDeviceId(e.target.value);
                remember(deviceKey, e.target.value);
              }}
            >
              <option value="">Default input</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Input ${i + 1}`}
                </option>
              ))}
            </select>
            <label className="row sender-check">
              <input
                type="checkbox"
                checked={processing}
                disabled={!!live.current}
                onChange={(e) => setProcessing(e.target.checked)}
              />
              Voice processing
            </label>
          </div>
        </div>
        <div className="sender-meter" aria-label="Input level">
          <div style={{ width: `${live.current ? meter : 0}%` }} />
        </div>
        {error && <p className="error">{error}</p>}
        {storageError && <p className="error">{storageError}</p>}
        {warning && live.current && <p className="sender-warning">{warning}</p>}
        {status?.lastError && status.state !== "connected" && <p className="error">Server: {status.lastError}</p>}
        {status?.notice && <p className="sender-warning">{status.notice}</p>}
        {quota && <p className="sender-warning">{quota.message}</p>}
      </section>

      <section className="stat">
        <div>
          <span className="muted">Recording time</span>
          <b>{formatDuration((status?.recorded ?? 0) * CHUNK_MS)}</b>
        </div>
        <div>
          <span className="muted">Chunks recorded / acked</span>
          <b>
            {status?.recorded ?? 0} / {status?.acked ?? 0}
          </b>
        </div>
        <div>
          <span className="muted">Unsent backlog</span>
          <b>
            {backlogChunks} · {formatBytes(backlogBytes)}
          </b>
        </div>
        <div>
          <span className="muted">Browser storage</span>
          <b>{estimate?.quota ? `${formatBytes(estimate.usage ?? 0)} / ${formatBytes(estimate.quota)}` : "unknown"}</b>
          <span className="muted">{persisted ? "persistent" : persisted === false ? "not persistent" : ""}</span>
        </div>
      </section>
      <p className="muted sender-ids">
        Stream: <code>{status?.wireStreamId ?? "–"}</code>
        {live.current && <> · format: {live.current.recorder.format}</>}
      </p>

      {others.length > 0 && (
        <section className="card">
          <h2 className="sender-h2">Finishing uploads</h2>
          {others.map((s) => (
            <div className="row" key={s.streamId}>
              {stateBadge(s)}
              <code>{s.wireStreamId}</code>
              <span className="muted">
                {s.backlogChunks} chunks ({formatDuration(s.backlogChunks * CHUNK_MS)}) · {formatBytes(s.backlogBytes)} left
              </span>
              {s.lastError && <span className="error">{s.lastError}</span>}
              {s.notice && <span className="sender-warning">{s.notice}</span>}
              {s.state === "gone" && (
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm("The room is gone, so this audio can't be uploaded. Delete it from this browser?")) {
                      void uploaders.current.get(s.streamId)?.discard();
                    }
                  }}
                >
                  Discard local backlog
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      <p className="sender-ids">
        {forgotten ? (
          <span className="muted">This browser no longer remembers the room password.</span>
        ) : (
          <button
            onClick={() => {
              setForgotten(true);
              onForget(active);
            }}
          >
            Forget password on this browser
          </button>
        )}
      </p>
    </>
  );
}

/** Only the newest few segments are kept for the preview. */
const PREVIEW_SEGMENTS = 4;

/**
 * A small read-back of the live transcript, so the crew can see transcription
 * is working. Loads one snapshot, then polls only the events since it.
 */
function TranscriptPreview({ paused }: { paused: boolean }) {
  const transcript = useRef<TranscriptState | null>(null);
  const [view, setView] = useState<{ segments: { id: string; text: string }[]; partials: LivePartial[] } | null>(null);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const base = `/api/rooms/${encodeURIComponent(roomId)}`;
    const trim = (state: TranscriptState) => {
      // Edits to dropped segments are ignored by applyEvent, so keeping only the newest is safe.
      const keep = new Set(
        orderedSegments(state)
          .slice(-PREVIEW_SEGMENTS * 2)
          .map((s) => s.id),
      );
      for (const id of Object.keys(state.segments)) if (!keep.has(id)) delete state.segments[id];
    };
    const poll = async () => {
      let partials: LivePartial[];
      if (!transcript.current) {
        const res = await fetch(base);
        if (!res.ok) return;
        const snapshot = (await res.json()) as { transcript: TranscriptState; partials: LivePartial[] };
        transcript.current = snapshot.transcript;
        partials = snapshot.partials;
      } else {
        const res = await fetch(`${base}/events?after=${transcript.current.seq}`);
        if (!res.ok) return;
        const body = (await res.json()) as { events: RoomEvent[]; seq: number; partials: LivePartial[] };
        if (body.seq < transcript.current.seq) {
          transcript.current = null; // The log went backwards (room recreated?): start over.
          return;
        }
        for (const event of body.events) {
          if (event.seq === transcript.current.seq + 1) applyEvent(transcript.current, event);
        }
        // Missed events (a gap): take a fresh snapshot next time.
        if (transcript.current.seq < body.seq && body.events.length === 0) transcript.current = null;
        partials = body.partials;
      }
      const state = transcript.current;
      if (!state || cancelled) return;
      trim(state);
      setView({
        segments: orderedSegments(state)
          .slice(-PREVIEW_SEGMENTS)
          .map((s) => ({ id: s.id, text: s.text })),
        partials,
      });
    };
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await poll().catch(() => {});
      if (!cancelled) timer = setTimeout(loop, 2000);
    };
    void loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paused]);

  if (!view) return null;
  return (
    <section className="card sender-transcript">
      <h2 className="sender-h2">Live transcript</h2>
      {paused && <p className="muted">Paused while the audio backlog uploads.</p>}
      {view.segments.length === 0 && view.partials.length === 0 && <p className="muted">Nothing transcribed yet.</p>}
      {view.segments.map((s) => (
        <p key={s.id}>{s.text}</p>
      ))}
      {view.partials.map((p) => (
        <p key={`${p.streamId}:${p.startMs}`} className="partial">
          {p.text}
        </p>
      ))}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
