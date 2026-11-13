import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { orderedSegments, segmentTime, type SegmentState, type TranscriptState } from "../shared/transcript.ts";
import { LiveRoom, type ConnectionState } from "./live.ts";

const roomId = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const passwordKey = `live-speech:room-password:${roomId}`;

function storedPassword() {
  try {
    return localStorage.getItem(passwordKey) ?? "";
  } catch {
    return "";
  }
}

function storePassword(password: string) {
  try {
    if (password) localStorage.setItem(passwordKey, password);
    else localStorage.removeItem(passwordKey);
  } catch {}
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function useLiveRoom() {
  const live = useMemo(() => new LiveRoom(roomId), []);
  useEffect(() => {
    void live.start();
    return () => live.dispose();
  }, [live]);
  return useSyncExternalStore(live.subscribe, live.getState);
}

const connectionLabel: Record<ConnectionState, [string, string]> = {
  live: ["Live", "ok"],
  polling: ["Live (polling)", "ok"],
  connecting: ["Connecting…", "warn"],
  offline: ["Reconnecting…", "bad"],
};

function App() {
  const state = useLiveRoom();
  const [captions, setCaptions] = useState(() => new URLSearchParams(location.search).get("mode") === "captions");
  const [password, setPassword] = useState(storedPassword);
  const [editing, setEditing] = useState(false);
  const segments = useMemo(() => orderedSegments(state.transcript), [state.transcript]);
  const partials = useMemo(
    () =>
      Object.values(state.partials)
        .filter((p) => p.text)
        .sort((a, b) => a.startMs - b.startMs),
    [state.partials],
  );

  useEffect(() => {
    if (state.room) document.title = `${state.room.name} · live-speech`;
  }, [state.room]);

  if (!state.room) {
    return (
      <main>
        <p className={state.error ? "error" : "muted"}>{state.error ?? "Loading…"}</p>
      </main>
    );
  }

  if (captions) {
    return (
      <Captions
        segments={segments}
        partialText={partials.map((p) => p.text).join(" ")}
        onExit={() => setCaptions(false)}
      />
    );
  }

  const [label, tone] = connectionLabel[state.connection];

  const enableEditing = async () => {
    let candidate = password;
    if (!candidate) {
      candidate = prompt("Room password (to edit the transcript):") ?? "";
      if (!candidate) return;
    }
    const res = await fetch(`/api/rooms/${roomId}/auth`, {
      method: "POST",
      headers: { authorization: `Bearer ${candidate}` },
    });
    if (!res.ok) {
      alert("That password is not right for this room.");
      storePassword("");
      setPassword("");
      return;
    }
    storePassword(candidate);
    setPassword(candidate);
    setEditing(true);
  };

  return (
    <main>
      <header className="viewer-header">
        <div className="row spread">
          <div>
            <h1>{state.room.name}</h1>
            <span className={`badge ${tone}`}>{label}</span>
          </div>
          <div className="row">
            <button
              onClick={() => {
                setCaptions(true);
                void document.documentElement.requestFullscreen?.().catch(() => {});
              }}
            >
              Captions
            </button>
            <a className="button" href={`/api/rooms/${roomId}/transcript.txt`} download={`${state.room.name}.txt`}>
              Download .txt
            </a>
            {editing ? (
              <button onClick={() => setEditing(false)}>Done editing</button>
            ) : (
              <button onClick={enableEditing}>Edit</button>
            )}
          </div>
        </div>
      </header>

      <Transcript
        transcript={state.transcript}
        segments={segments}
        partials={partials.map((p) => p.text)}
        editing={editing}
        password={password}
      />

      <AgentHelp />
    </main>
  );
}

function Transcript({
  transcript,
  segments,
  partials,
  editing,
  password,
}: {
  transcript: TranscriptState;
  segments: SegmentState[];
  partials: string[];
  editing: boolean;
  password: string;
}) {
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the live end unless the reader has scrolled up.
  useEffect(() => {
    const onScroll = () => {
      // Following = the live end of the transcript is (nearly) on screen.
      const end = endRef.current?.getBoundingClientRect().top ?? 0;
      setFollow(end < window.innerHeight + 120);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (follow && !editing) endRef.current?.scrollIntoView({ block: "end" });
  }, [segments, partials, follow, editing]);

  return (
    <section className="transcript">
      {segments.length === 0 && partials.length === 0 && (
        <p className="muted">Nothing has been said yet. The transcript will appear here live.</p>
      )}
      {segments.map((segment) => (
        <Segment
          key={segment.id}
          segment={segment}
          time={segmentTime(transcript, segment)}
          editing={editing}
          password={password}
        />
      ))}
      {partials.map((text, i) => (
        <p key={i} className="segment partial">
          <span className="time" />
          <span className="text">{text}</span>
        </p>
      ))}
      <div ref={endRef} />
      {!follow && (
        <button className="primary jump" onClick={() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })}>
          ↓ Jump to live
        </button>
      )}
    </section>
  );
}

function Segment({
  segment,
  time,
  editing,
  password,
}: {
  segment: SegmentState;
  time: number;
  editing: boolean;
  password: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: object) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/rooms/${roomId}/segments/${segment.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${password}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, author: "viewer" }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (editing && open) {
    return (
      <div className="segment card editing">
        <span className="time">{clock(time)}</span>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => patch({ text: draft })}>
            Save
          </button>
          <button onClick={() => setOpen(false)}>Cancel</button>
          {error && <span className="error">{error}</span>}
        </div>
        {segment.versions.length > 1 && (
          <details>
            <summary className="muted">History ({segment.versions.length} versions)</summary>
            <ol className="history">
              {segment.versions.map((v) => (
                <li key={v.seq}>
                  <span className="muted">
                    {clock(v.at)} · {v.author}
                  </span>{" "}
                  {v.text}{" "}
                  {v.text !== segment.text && (
                    <button disabled={busy} onClick={() => patch({ revertTo: v.seq })}>
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    );
  }

  return (
    <p
      className={`segment${editing ? " editable" : ""}`}
      onClick={
        editing
          ? () => {
              setDraft(segment.text);
              setOpen(true);
            }
          : undefined
      }
    >
      <span className="time">{clock(time)}</span>
      <span className="text">{segment.text}</span>
      {segment.versions.length > 1 && <span className="edited muted"> (edited)</span>}
    </p>
  );
}

function Captions({ segments, partialText, onExit }: { segments: SegmentState[]; partialText: string; onExit: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onExit();
    const onFullscreen = () => !document.fullscreenElement && onExit();
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, [onExit]);

  const recent = segments.slice(-3);
  return (
    <div className="captions" onDoubleClick={onExit}>
      <div className="captions-text">
        {recent.map((s) => (
          <span key={s.id}>{s.text} </span>
        ))}
        {partialText && <span className="partial">{partialText}</span>}
      </div>
    </div>
  );
}

function AgentHelp() {
  const base = `${location.origin}/api/rooms/${roomId}`;
  const prompt = `The live transcript of a talk is at ${base}/transcript.txt (plain text, one segment per line). For structured data with segment ids and timings, GET ${base}/transcript.json. To follow along without re-reading everything, GET ${base}/events?after=<seq> with the last seq you saw.`;
  return (
    <details className="card agent-help">
      <summary>
        <b>Connect an AI agent</b> <span className="muted">— read (and optionally fix) this transcript over HTTP</span>
      </summary>
      <p>Paste this into your agent:</p>
      <pre>{prompt}</pre>
      <button onClick={() => navigator.clipboard?.writeText(prompt)}>Copy</button>
      <h3>Endpoints</h3>
      <pre>{`GET ${base}/transcript.txt        # plain text, cheapest to read
GET ${base}/transcript.json       # segments: id, startMs, endMs, text
GET ${base}/events?after=SEQ      # only what changed since SEQ`}</pre>
      <h3>Editing (needs the room password)</h3>
      <pre>{`curl -X PATCH ${base}/segments/SEGMENT_ID \\
  -H "authorization: Bearer ROOM_PASSWORD" \\
  -H "content-type: application/json" \\
  -d '{"text": "corrected text", "author": "my-agent"}'

# Every edit is kept. Undo by restoring an earlier version:
curl ${base}/segments/SEGMENT_ID          # lists versions with their seq
curl -X PATCH ${base}/segments/SEGMENT_ID \\
  -H "authorization: Bearer ROOM_PASSWORD" \\
  -H "content-type: application/json" \\
  -d '{"revertTo": VERSION_SEQ}'`}</pre>
    </details>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
