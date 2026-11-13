import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { orderedSegments, segmentTime, type SegmentState, type TranscriptState } from "../shared/transcript.ts";
import { agentEditPrompt, agentReadPrompt } from "./agentPrompt.ts";
import { LiveRoom, type ConnectionState } from "./live.ts";

const roomId = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const passwordKey = `live-speech:room-password:${roomId}`;
const api = `/api/rooms/${encodeURIComponent(roomId)}`;

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

const timeFormat = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function clock(ms: number) {
  return timeFormat.format(ms);
}

function useLiveRoom() {
  const live = useMemo(() => new LiveRoom(roomId), []);
  useEffect(() => {
    void live.start();
    return () => live.dispose();
  }, [live]);
  return useSyncExternalStore(live.subscribe, live.getState);
}

/**
 * Applies the room's custom CSS after the built-in styles. The admin page
 * embeds the viewer in an iframe and sends draft CSS by postMessage, so it
 * can be previewed before it is saved.
 */
function useRoomCss(saved: string | undefined) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== "live-speech:preview-css") return;
      setPreview(typeof e.data.css === "string" ? e.data.css : null);
    };
    window.addEventListener("message", onMessage);
    if (window.parent !== window) window.parent.postMessage({ type: "live-speech:viewer-ready" }, location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const css = preview ?? saved ?? "";
  useEffect(() => {
    let style = document.getElementById("room-css") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "room-css";
      document.head.append(style);
    }
    style.textContent = css;
  }, [css]);
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
  useRoomCss(state.transcript.css);
  useEffect(() => {
    document.body.dataset.mode = captions ? "captions" : "transcript";
  }, [captions]);
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
    const res = await fetch(`${api}/auth`, {
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
            <h1 className="room-name">{state.room.name}</h1>
            <span className={`badge status ${tone}`}>{label}</span>
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
            <a className="button" href={`${api}/transcript.txt`} download={`${state.room.name}.txt`}>
              Download .txt
            </a>
            {editing ? (
              <>
                <CopyButton
                  text={agentEditPrompt(`${location.origin}${api}`, password)}
                  label="Copy prompt for AI editor"
                />
                <button onClick={() => setEditing(false)}>Done editing</button>
              </>
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

/**
 * Scrolls this window only. scrollIntoView would also scroll the pages that
 * embed it, such as the admin's live preview.
 */
function scrollToEnd(behavior: ScrollBehavior) {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
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

  const sectionRef = useRef<HTMLElement>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Follow the live end unless the reader has scrolled up.
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const end = endRef.current?.getBoundingClientRect().top ?? 0;
      // Only scrolling up stops following. The browser also scrolls by itself
      // (scroll anchoring when the layout changes, e.g. new custom CSS), and
      // that must not count as the reader leaving.
      if (end < window.innerHeight + 40) setFollow(true);
      else if (y < lastY) setFollow(false);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    // Stay pinned to the end when the layout changes size (fonts, CSS, window).
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToEnd("instant");
    });
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => {
      window.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (follow && !editing) scrollToEnd("instant");
  }, [segments, partials, follow, editing]);

  return (
    <section className="transcript" ref={sectionRef}>
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
        <button className="primary jump" onClick={() => scrollToEnd("smooth")}>
          ↓ Jump to live
        </button>
      )}
    </section>
  );
}

// Memoized: with thousands of segments, only changed ones should re-render.
const Segment = memo(function Segment({
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
      const res = await fetch(`${api}/segments/${encodeURIComponent(segment.id)}`, {
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
});

function Captions({
  segments,
  partialText,
  onExit,
}: {
  segments: SegmentState[];
  partialText: string;
  onExit: () => void;
}) {
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
  const base = `${location.origin}${api}`;
  const prompt = agentReadPrompt(base);
  return (
    <details className="card agent-help">
      <summary>
        <b>API access</b>
      </summary>
      <p>Paste this into your AI agent:</p>
      <pre>{prompt}</pre>
      <CopyButton text={prompt} label="Copy prompt" />
      <h3>Endpoints</h3>
      <pre>{`GET ${base}/transcript.txt        # plain text, cheapest to read
GET ${base}/transcript.json       # segments: id, startMs, endMs, text
GET ${base}/events?after=SEQ      # only what changed since SEQ`}</pre>
    </details>
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

createRoot(document.getElementById("root")!).render(<App />);
