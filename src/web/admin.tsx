import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const masterKey = "live-speech:master-password";

interface AdminStream {
  id: string;
  format: string;
  createdAt: number;
  startedAt: number | null;
  clockRtt: number | null;
  durationMs: number;
  transcribedMs: number;
  ended: boolean;
  costUsd: number;
}

interface AdminUsage {
  streamId: string;
  model: string;
  audioMs: number;
  sessions: number;
  costUsd: number;
}

interface AdminRoom {
  id: string;
  name: string;
  password: string;
  createdAt: number;
  streams: AdminStream[];
  usage: { audioMs: number; costUsd: number; byStream: AdminUsage[] };
}

function readMaster() {
  try {
    return sessionStorage.getItem(masterKey) ?? "";
  } catch {
    return "";
  }
}

function writeMaster(value: string) {
  try {
    if (value) sessionStorage.setItem(masterKey, value);
    else sessionStorage.removeItem(masterKey);
  } catch {}
}

function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h ` : ""}${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function usd(amount: number) {
  return `$${amount.toFixed(amount > 0 && amount < 1 ? 4 : 2)}`;
}

function App() {
  const [master, setMaster] = useState(readMaster);
  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { authorization: `Bearer ${master}`, "content-type": "application/json", ...init.headers },
      });
      if (res.status === 401) {
        writeMaster("");
        setMaster("");
        throw new Error("Wrong master password.");
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      return res;
    },
    [master],
  );

  const refresh = useCallback(async () => {
    if (!master) return;
    try {
      setRooms(await (await api("/api/admin/rooms")).json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, master]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!master) {
    return (
      <main>
        <h1>live-speech</h1>
        <p className="muted">Live captions for tech talks. Sign in to manage rooms.</p>
        <form
          className="card row"
          onSubmit={(e) => {
            e.preventDefault();
            const value = String(new FormData(e.currentTarget).get("password") ?? "");
            writeMaster(value);
            setMaster(value);
          }}
        >
          <input name="password" type="password" placeholder="Master password" autoFocus required />
          <button className="primary">Sign in</button>
          {error && <span className="error">{error}</span>}
        </form>
      </main>
    );
  }

  return (
    <main>
      <div className="row spread">
        <h1>Rooms</h1>
        <button
          onClick={() => {
            writeMaster("");
            setMaster("");
          }}
        >
          Sign out
        </button>
      </div>
      <form
        className="card row"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const name = String(new FormData(form).get("name") ?? "").trim();
          if (!name) return;
          try {
            await api("/api/admin/rooms", { method: "POST", body: JSON.stringify({ name }) });
            form.reset();
            await refresh();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input name="name" placeholder="New room name, e.g. “Meetup #42 — main stage”" required style={{ flex: 1 }} />
        <button className="primary">Create room</button>
      </form>
      {error && <p className="error">{error}</p>}
      {rooms === null ? (
        <p className="muted">Loading…</p>
      ) : rooms.length === 0 ? (
        <p className="muted">No rooms yet.</p>
      ) : (
        rooms.map((room) => <RoomCard key={room.id} room={room} api={api} refresh={refresh} />)
      )}
    </main>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function RoomCard({
  room,
  api,
  refresh,
}: {
  room: AdminRoom;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const viewerUrl = `${location.origin}/rooms/${room.id}`;
  const senderUrl = `${viewerUrl}/send`;
  const invite = `Audio sender for “${room.name}”\n${senderUrl}\nRoom password: ${room.password}`;
  const totalMs = room.streams.reduce((n, s) => n + s.durationMs, 0);

  /** Runs an admin action, reporting failure instead of failing silently. */
  const attempt = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const exportRoom = attempt(async () => {
    const data = await (await api(`/api/admin/rooms/${room.id}/export`)).blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(data);
    a.download = `live-speech-${room.id}.sqlite`;
    a.click();
    // Revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  });

  return (
    <div className="card">
      <div className="row spread">
        <div>
          <h2 style={{ margin: 0 }}>{room.name}</h2>
          <span className="muted">
            {room.streams.length} stream{room.streams.length === 1 ? "" : "s"} · {duration(totalMs)} recorded ·{" "}
            <span
              title={`${duration(room.usage.audioMs)} of audio sent to ${[...new Set(room.usage.byStream.map((u) => u.model))].join(", ") || "the transcription model"}`}
            >
              {usd(room.usage.costUsd)} transcription
            </span>{" "}
            · created {new Date(room.createdAt).toLocaleString()}
          </span>
        </div>
        <a href={viewerUrl} target="_blank" rel="noreferrer">
          Open viewer ↗
        </a>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <span>Room password:</span>
        <code>{showPassword ? room.password : "•".repeat(12)}</code>
        <button onClick={() => setShowPassword((v) => !v)}>{showPassword ? "Hide" : "Show"}</button>
        <CopyButton text={invite} label="Copy invite for audio crew" />
        <CopyButton text={viewerUrl} label="Copy viewer link" />
      </div>

      {room.streams.length > 0 && (
        <table className="streams">
          <thead>
            <tr>
              <th>Stream</th>
              <th>Started</th>
              <th>Recorded</th>
              <th>Transcribed</th>
              <th>Cost</th>
              <th>Format</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {room.streams.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.id.slice(0, 10)}</code>{" "}
                  <span className={`badge ${s.ended ? "" : "ok"}`}>{s.ended ? "ended" : "open"}</span>
                </td>
                <td>{s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : "—"}</td>
                <td>{duration(s.durationMs)}</td>
                <td>{duration(s.transcribedMs)}</td>
                <td>{usd(s.costUsd)}</td>
                <td>{s.format}</td>
                <td>
                  <a href={`/api/rooms/${room.id}/streams/${s.id}/audio.wav`} download>
                    WAV
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button onClick={exportRoom}>Export room (audio + transcript)</button>
        <button
          onClick={attempt(async () => {
            if (!confirm(`Give “${room.name}” a new password? Senders using the old one will be cut off.`)) return;
            await api(`/api/admin/rooms/${room.id}/password`, { method: "POST" });
            await refresh();
          })}
        >
          New password
        </button>
        <button
          className="danger"
          onClick={attempt(async () => {
            const answer = prompt(
              `Delete “${room.name}” with all its audio and transcript? This cannot be undone. Export first.\n\nType the room name to confirm:`,
            );
            if (answer !== room.name) return;
            await api(`/api/admin/rooms/${room.id}`, { method: "DELETE" });
            await refresh();
          })}
        >
          Delete room
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
