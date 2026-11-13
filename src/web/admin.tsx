import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { agentEditPrompt } from "./agentPrompt.ts";

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
  css: string;
  senders: { streamId: string | null; connectedMs: number; silentMs: number | null }[];
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

interface Retranscription {
  id: string;
  streamId: string;
  fromMs: number;
  toMs: number;
  model: string;
  status: "running" | "done" | "failed";
  progressMs: number;
  error?: string;
  replaced?: number;
  added?: number;
  undone?: boolean;
}

/** A sender is live if audio arrived recently; chunks come every 100 ms. */
function SenderBadge({ sender }: { sender: AdminRoom["senders"][number] | undefined }) {
  if (!sender) return null;
  if (sender.silentMs !== null && sender.silentMs < 3000) return <span className="badge ok">● live</span>;
  return (
    <span className="badge warn" title="Connected, but no audio is arriving">
      connected, no audio{sender.silentMs !== null ? ` for ${Math.round(sender.silentMs / 1000)} s` : ""}
    </span>
  );
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
  const [jobs, setJobs] = useState<Retranscription[]>([]);
  const loadJobs = useCallback(async () => {
    try {
      setJobs(await (await api(`/api/admin/rooms/${room.id}/retranscriptions`)).json());
    } catch {}
  }, [api, room.id]);
  useEffect(() => {
    void loadJobs();
    const timer = setInterval(loadJobs, 2000);
    return () => clearInterval(timer);
  }, [loadJobs]);
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
          <h2 style={{ margin: 0 }}>
            {room.name}{" "}
            {room.senders.length === 0 ? (
              <span className="badge">no sender</span>
            ) : (
              <SenderBadge
                sender={[...room.senders].sort((a, b) => (a.silentMs ?? Infinity) - (b.silentMs ?? Infinity))[0]}
              />
            )}
          </h2>
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
        <CopyButton
          text={agentEditPrompt(`${location.origin}/api/rooms/${room.id}`, room.password)}
          label="Copy prompt for AI editor"
        />
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
                  {room.senders.some((x) => x.streamId === s.id) ? (
                    <SenderBadge sender={room.senders.find((x) => x.streamId === s.id)} />
                  ) : (
                    <span className="badge">{s.ended ? "ended" : "open"}</span>
                  )}
                </td>
                <td>{s.startedAt ? new Date(s.startedAt).toLocaleTimeString() : "—"}</td>
                <td>{duration(s.durationMs)}</td>
                <td>{duration(s.transcribedMs)}</td>
                <td>{usd(s.costUsd)}</td>
                <td>{s.format}</td>
                <td className="row">
                  <a href={`/api/rooms/${room.id}/streams/${s.id}/audio.wav`} download>
                    WAV
                  </a>
                  <button
                    disabled={jobs.some((j) => j.streamId === s.id && j.status === "running")}
                    title="Run this stream's recorded audio through the model again. The new segments replace the old ones (edits included); you can undo it."
                    onClick={attempt(async () => {
                      if (
                        !confirm(
                          `Re-transcribe ${duration(s.transcribedMs)} of audio? This replaces its segments, edits included, You can undo it.`,
                        )
                      )
                        return;
                      await api(`/api/admin/rooms/${room.id}/streams/${s.id}/retranscribe`, {
                        method: "POST",
                        body: "{}",
                      });
                      await loadJobs();
                    })}
                  >
                    Re-transcribe
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {jobs.length > 0 && (
        <ul className="jobs">
          {jobs.map((j) => (
            <li key={j.id}>
              Re-transcription of <code>{j.streamId.slice(0, 10)}</code> {duration(j.fromMs)}–{duration(j.toMs)} with{" "}
              {j.model}:{" "}
              {j.status === "running" ? (
                <span className="badge">{Math.round((j.progressMs / Math.max(1, j.toMs - j.fromMs)) * 100)}%</span>
              ) : j.status === "failed" ? (
                <span className="error">failed ({j.error}); transcript unchanged</span>
              ) : j.undone ? (
                <span className="muted">undone</span>
              ) : (
                <>
                  <span className="badge ok">done</span> {j.replaced} segments → {j.added}{" "}
                  <button
                    onClick={attempt(async () => {
                      await api(`/api/admin/rooms/${room.id}/retranscriptions/${j.id}/undo`, { method: "POST" });
                      await loadJobs();
                    })}
                  >
                    Undo
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <ViewerStyleEditor room={room} api={api} refresh={refresh} />

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

const CSS_HELP: [string, string][] = [
  ["body", "The page. Its data-mode attribute is transcript or captions."],
  ['body[data-mode="captions"]', "Only in captions (fullscreen) mode."],
  [".viewer-header", "Top bar: .room-name (the title), .status (Live badge) and the buttons."],
  [".transcript", "The list of segments."],
  [".segment", "One line of the transcript. Inside: .time and .text."],
  [".segment.partial", "Text still being recognized (not final yet)."],
  [".captions", "Captions mode backdrop."],
  [".captions-text", "Captions text: the last few segments, then a .partial span."],
  [".agent-help", "The “API access” box."],
];

const CSS_EXAMPLE = `/* Big, high-contrast captions for the projector */
.captions { background: #000; }
.captions-text { font-size: 4rem; color: #ff0; }

/* Hide timestamps and the API access box */
.segment .time, .agent-help { display: none; }`;

/** Custom viewer CSS, previewed live in an embedded viewer before saving. */
function ViewerStyleEditor({
  room,
  api,
  refresh,
}: {
  room: AdminRoom;
  api: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(room.css);
  const [saved, setSaved] = useState(room.css);
  const [mode, setMode] = useState<"transcript" | "captions">("transcript");
  const [status, setStatus] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const dirty = draft !== saved;

  // Follow saves made elsewhere, unless there are unsaved edits here.
  useEffect(() => {
    if (!dirty) setDraft(room.css);
    setSaved(room.css);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.css]);

  const sendPreview = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "live-speech:preview-css", css: draft }, location.origin);
  }, [draft]);
  useEffect(sendPreview, [sendPreview]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && e.data?.type === "live-speech:viewer-ready") sendPreview();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendPreview]);

  const save = async () => {
    try {
      await api(`/api/admin/rooms/${room.id}/css`, { method: "PUT", body: JSON.stringify({ css: draft }) });
      setSaved(draft);
      setStatus("Saved. Viewers have it now.");
      await refresh();
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  return (
    <details className="style-editor" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        Customize viewer CSS {saved ? <span className="badge">custom</span> : null}{" "}
        {dirty && <span className="badge warn">unsaved</span>}
      </summary>
      {open && (
        <div className="style-editor-body">
          <div className="style-editor-edit">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setStatus(null);
              }}
              spellCheck={false}
              placeholder={CSS_EXAMPLE}
              aria-label="Custom CSS for this room's viewer"
            />
            <div className="row">
              <button className="primary" disabled={!dirty} onClick={save}>
                Save and apply to all viewers
              </button>
              <button disabled={!dirty} onClick={() => setDraft(saved)}>
                Discard changes
              </button>
              {status && <span className="muted">{status}</span>}
            </div>
            <div className="css-help">
              <p className="muted">
                The preview shows your draft; viewers see it only after you save. Your CSS loads after the built-in
                styles, so plain selectors override them. Useful selectors:
              </p>
              <table>
                <tbody>
                  {CSS_HELP.map(([selector, what]) => (
                    <tr key={selector}>
                      <td>
                        <code>{selector}</code>
                      </td>
                      <td>{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">
                Built-in colors are CSS variables on <code>:root</code> (<code>--bg</code>, <code>--surface</code>,{" "}
                <code>--text</code>, <code>--muted</code>, <code>--accent</code>, <code>--partial</code>…), so{" "}
                <code>:root {"{ --bg: #000; }"}</code> restyles everything at once. Every saved version stays in the
                room's event log.
              </p>
              <button onClick={() => setDraft(CSS_EXAMPLE)} disabled={!!draft}>
                Insert example
              </button>
            </div>
          </div>
          <div className="style-editor-preview">
            <div className="row">
              <span className="muted">Preview</span>
              <button onClick={() => setMode("transcript")} disabled={mode === "transcript"}>
                Transcript
              </button>
              <button onClick={() => setMode("captions")} disabled={mode === "captions"}>
                Captions
              </button>
            </div>
            <iframe
              ref={frame}
              key={mode}
              title="Viewer preview"
              src={`/rooms/${room.id}${mode === "captions" ? "?mode=captions" : ""}`}
            />
          </div>
        </div>
      )}
    </details>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
