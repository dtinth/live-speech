import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CHUNK_MS } from "../shared/protocol.ts";
import type { LivePartial } from "../shared/transcript.ts";
import { IndexedDbChunkStore, type ChunkStore, type StoredStream } from "./sender/chunkStore.ts";
import { Recorder, listInputDevices } from "./sender/recorder.ts";
import { StreamUploader, storageWarning, webSocketFactory, type UploaderStatus } from "./sender/uploader.ts";

const roomId = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const passwordKey = `live-speech:room-password:${roomId}`;
const deviceKey = "live-speech:input-device";

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

function randomStreamId() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
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

interface Live {
  recorder: Recorder;
  uploader: StreamUploader;
}

function App() {
  const [roomName, setRoomName] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [store, setStore] = useState<ChunkStore | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);

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
        <PasswordForm onAuthenticated={setPassword} />
      ) : store ? (
        <Sender store={store} password={password} />
      ) : (
        !storeError && <p className="muted">Opening local storage…</p>
      )}
      <TranscriptPreview />
    </main>
  );
}

function PasswordForm({ onAuthenticated }: { onAuthenticated(password: string): void }) {
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
            remember(passwordKey, value);
            onAuthenticated(value);
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

function Sender({ store, password }: { store: ChunkStore; password: string }) {
  useTick(250);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => recall(deviceKey) ?? "");
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const live = useRef<Live | null>(null);
  /** Streams being uploaded that are no longer recording: stopped here, or left over from an earlier page load. */
  const background = useRef(new Map<string, StreamUploader>());
  const level = useRef(0);
  const shownLevel = useRef(0);

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

  // Resume unfinished streams for this room: ones left by a reload or crash.
  useEffect(() => {
    let cancelled = false;
    const scan = async () => {
      const streams = await store.listStreams();
      for (const stream of streams) {
        if (cancelled) return;
        if (stream.roomId !== roomId || background.current.has(stream.id) || live.current?.uploader.streamId === stream.id) {
          continue;
        }
        resume(stream);
      }
    };
    const resume = (stream: StoredStream) => {
      // Skips streams another open tab still holds (it is recording or uploading them).
      void withStreamLock(stream.id, false, async () => {
        if (cancelled) return;
        const uploader = await StreamUploader.start({
          store,
          stream: { ...stream, stopped: true },
          connect: webSocketFactory(ingestUrl()),
          password,
          elapsed: null, // Its start isn't on this page's clock, so leave clock sync alone.
        });
        background.current.set(stream.id, uploader);
        await uploader.finish();
      });
    };
    scan().catch((e) => setError(`Could not read local backlog: ${(e as Error).message}`));
    // Look again now and then: a tab that crashed after this one loaded leaves a stream behind too.
    const timer = setInterval(() => scan().catch(() => {}), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [store, password]);

  // Warn before leaving while anything is recording or unsent. (The backlog would survive, but only resume when the page is reopened.)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const pending = [...background.current.values()].some((u) => u.status().state !== "done");
      if (live.current || pending) e.preventDefault();
    };
    addEventListener("beforeunload", handler);
    return () => removeEventListener("beforeunload", handler);
  }, []);

  const start = async () => {
    setStarting(true);
    setError(null);
    // Ask for persistent storage so the browser won't evict an unsent backlog under pressure.
    navigator.storage?.persist?.().then(setPersisted, () => {});
    const streamId = randomStreamId();
    let uploader: StreamUploader | null = null;
    const early: Uint8Array[] = [];
    const save = (payload: Uint8Array) =>
      uploader!.addChunk(payload).catch((e) => setError(`Could not save audio locally: ${(e as Error).message}`));
    try {
      // Recording starts here, before anything touches the network; chunks
      // that arrive before the uploader exists wait in `early`.
      const recorder = await Recorder.start({
        deviceId: deviceId || undefined,
        processing,
        onChunk: (_seq, payload) => (uploader ? save(payload) : early.push(payload)),
        onLevel: (peak) => (level.current = Math.max(level.current, peak)),
        onError: (e) => setError(e.message),
      });
      refreshDevices(); // Labels become available once permission is granted.
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => (releaseLock = resolve));
      await withStreamLock(streamId, true, () => lockReleased);
      const stream: StoredStream = { id: streamId, roomId, format: recorder.format, createdAt: Date.now(), stopped: false };
      uploader = await StreamUploader.start({
        store,
        stream,
        connect: webSocketFactory(ingestUrl()),
        password,
        elapsed: () => recorder.elapsed(),
      });
      early.splice(0).forEach(save);
      live.current = { recorder, uploader };
      void uploader.whenDone().then(releaseLock);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    const current = live.current;
    if (!current) return;
    live.current = null;
    background.current.set(current.uploader.streamId, current.uploader);
    await current.recorder.stop();
    await current.uploader.finish();
  };

  const status = live.current?.uploader.status() ?? null;
  const others = [...background.current.values()].map((u) => u.status()).filter((s) => s.state !== "done");
  const backlogChunks = (status?.backlogChunks ?? 0) + others.reduce((n, s) => n + s.backlogChunks, 0);
  const backlogBytes = (status?.backlogBytes ?? 0) + others.reduce((n, s) => n + s.backlogBytes, 0);
  const warning = storageWarning(estimate);

  // Show the loudest peak since the last render, falling back gently so short sounds stay visible.
  const peak = Math.max(level.current, shownLevel.current * 0.6);
  shownLevel.current = peak;
  level.current = 0;
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const meter = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

  return (
    <>
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
        {status?.lastError && <p className="error">Server: {status.lastError}</p>}
        {warning && <p className="sender-warning">{warning.message}</p>}
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
        Stream: <code>{status?.streamId ?? "–"}</code>
        {live.current && <> · format: {live.current.recorder.format}</>}
      </p>

      {others.length > 0 && (
        <section className="card">
          <h2 className="sender-h2">Finishing uploads</h2>
          {others.map((s) => (
            <div className="row" key={s.streamId}>
              {stateBadge(s)}
              <code>{s.streamId}</code>
              <span className="muted">
                {s.backlogChunks} chunks ({formatDuration(s.backlogChunks * CHUNK_MS)}) · {formatBytes(s.backlogBytes)} left
              </span>
              {s.lastError && <span className="error">{s.lastError}</span>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

interface TranscriptJson {
  segments: { id: string; text: string }[];
  partials: LivePartial[];
}

/** A small read-back of the live transcript, so the crew can see transcription is working. */
function TranscriptPreview() {
  const [data, setData] = useState<TranscriptJson | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      fetch(`/api/rooms/${encodeURIComponent(roomId)}/transcript.json`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => !cancelled && json && setData(json))
        .catch(() => {});
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  if (!data) return null;
  const segments = data.segments.slice(-4);
  return (
    <section className="card sender-transcript">
      <h2 className="sender-h2">Live transcript</h2>
      {segments.length === 0 && data.partials.length === 0 && <p className="muted">Nothing transcribed yet.</p>}
      {segments.map((s) => (
        <p key={s.id}>{s.text}</p>
      ))}
      {data.partials.map((p) => (
        <p key={`${p.streamId}:${p.startMs}`} className="partial">
          {p.text}
        </p>
      ))}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
