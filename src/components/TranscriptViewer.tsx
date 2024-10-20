import { useStore } from "@nanostores/react";
import { atom, computed, type WritableAtom } from "nanostores";
import { ofetch } from "ofetch";
import { useEffect, useMemo, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import ReconnectingWebSocket from "reconnecting-websocket";
import type { BackendContext } from "../BackendContext";
import "./TranscriptViewer.css";
import { $autoCorrects, $autoScroll } from "./TranscriptViewerKnobs";

const $autocorrectables = atom<React.RefObject<HTMLDivElement>[]>([]);

const $autoCorrector = computed([$autoCorrects], (autoCorrects) => {
  const items = autoCorrects
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x)
    .flatMap((x) => {
      const [from, to] = x.split("=>").map((x) => x.trim());
      if (!from || !to) return [];
      return [{ from, to }];
    });
  return {
    correct: (text: string) => {
      let correctedText = text;
      for (const { from, to } of items) {
        const regex = new RegExp(from, "gi");
        correctedText = correctedText.replace(regex, to);
      }
      // Add spaces between Thai and non-Thai words.
      correctedText = correctedText
        .replace(/([ก-๙])([a-zA-Z0-9])/g, "$1 $2")
        .replace(/([a-zA-Z0-9])([ก-๙])/g, "$1 $2")
        .trim();
      return correctedText;
    },
  };
});

export function TranscriptViewer() {
  const params = new URLSearchParams(window.location.search);

  const backend = params.get("backend");
  const room = params.get("room");
  const key = params.get("key") || undefined;
  if (!backend || !room) {
    return <div>Missing parameters</div>;
  }

  const backendContext: BackendContext = { backend, room, key };
  return <TranscriptViewerView backendContext={backendContext} />;
}

function createViewer(backendContext: BackendContext) {
  const ws = new ReconnectingWebSocket(
    `${backendContext.backend.replace(/^http/, "ws")}/rooms/${
      backendContext.room
    }/publicEvents`
  );
  const bufferedPartial = new Map<string, string>();
  ws.onmessage = async (e) => {
    const json = JSON.parse(e.data);
    console.log(json);
    if (json.method === "updated") {
      const state: ItemState = json.params;
      const id = state.id;
      const item = $items.get().find((item) => item.id === id);
      if (item) {
        item.$state.set(state);
      } else {
        $items.set([
          ...$items.get(),
          {
            id,
            $state: atom(state),
            $partial: atom(bufferedPartial.get(id) || undefined),
          },
        ]);
      }
    } else if (json.method === "partial_transcript") {
      const id = json.params.id;
      const item = $items.get().find((item) => item.id === id);
      bufferedPartial.set(id, json.params.transcript);
      if (item) {
        item.$partial.set(json.params.transcript);
      }
    }
  };
  const $items = atom<ViewerTranscriptItem[]>([]);
  async function init() {
    const items = await ofetch<ItemState[]>(
      `${backendContext.backend}/rooms/${backendContext.room}/items`
    );
    $items.set(
      items.map((item): ViewerTranscriptItem => {
        return {
          id: item.id,
          $state: atom(item),
          $partial: atom(),
        };
      })
    );
  }
  init();
  return {
    $items,
    editable: !!backendContext.key,
    async updateTranscript(id: string, transcript: string) {
      await ofetch(
        `${backendContext.backend}/rooms/${backendContext.room}/items/${id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ transcript, transcriptBy: "manual" }),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${backendContext.key}`,
          },
        }
      );
    },
    getAudioUrl(id: string) {
      return `${backendContext.backend}/pcm/${id}`;
    },
  };
}

interface ItemState {
  id: string;
  start: string;
  finish: string;
  length: number;
  transcript?: string;
}

interface ViewerTranscriptItem {
  id: string;
  $state: WritableAtom<ItemState>;
  $partial: WritableAtom<string | undefined>;
}

type Viewer = ReturnType<typeof createViewer>;
let _viewer: Viewer | undefined;

function TranscriptViewerView(props: { backendContext: BackendContext }) {
  const viewer = (_viewer ??= createViewer(props.backendContext));
  const items = useStore(viewer.$items);
  return (
    <div>
      <h1>Transcript for room {props.backendContext.room}</h1>
      <div className="TranscriptViewer">
        {items.map((item) => {
          return (
            <TranscriptItem
              start={formatTime(new Date(item.$state.get().start))}
              key={item.id}
              item={item}
              viewer={viewer}
            />
          );
        })}
      </div>
      <TranscriptViewerOptions viewer={viewer} />
    </div>
  );
}

const scroller = (() => {
  let toScroll = 0;
  let timeout: number | undefined;
  return {
    scrollBy(v: number) {
      console.log(v);
      if (!timeout) {
        timeout = setTimeout(() => {
          const amount = toScroll;
          toScroll = 0;
          timeout = undefined;
          if (amount < 0) return;
          smoothScroll(amount);
        }, 120) as unknown as number;
      }
      toScroll = Math.max(v, toScroll);
    },
  };
})();

function smoothScroll(amount: number) {
  console.log(amount);
  let last = 0;
  let current = 0;
  amount = Math.round(amount);
  const frame = () => {
    current += (amount - current) / 5;
    const nextValue = Math.round(current);
    if (nextValue > last) {
      window.scrollBy({
        top: nextValue - last,
        behavior: "instant",
      });
      last = nextValue;
    }
    if (nextValue < amount) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}

function TranscriptItem(props: {
  start: string;
  item: ViewerTranscriptItem;
  viewer: Viewer;
}) {
  const div = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const { item, viewer } = props;
  const state = useStore(item.$state);
  const partial = useStore(item.$partial);
  const [isEditing, setIsEditing] = useState<false | { width: number }>(false);
  const transcribed = state.transcript != null;
  const [wasUntranscribed] = useState(!transcribed);
  const corrector = useStore($autoCorrector);
  const corrected = useMemo(() => {
    if (!state.transcript || !viewer.editable) return state.transcript;
    return corrector.correct(state.transcript);
  }, [corrector, state.transcript, viewer.editable]);

  const needsCorrection = corrected !== state.transcript;
  const autoCorrectableAdded = useRef(false);
  useEffect(() => {
    if (needsCorrection && !autoCorrectableAdded.current) {
      $autocorrectables.set([...$autocorrectables.get(), div]);
      autoCorrectableAdded.current = true;
    } else if (!needsCorrection && autoCorrectableAdded.current) {
      $autocorrectables.set($autocorrectables.get().filter((x) => x !== div));
      autoCorrectableAdded.current = false;
    }
  }, [needsCorrection]);

  useEffect(() => {
    if (transcribed && wasUntranscribed && div.current && $autoScroll.get()) {
      const clientRect = div.current.getBoundingClientRect();
      // Do not scroll if focusing on a text area.
      if (document.activeElement instanceof HTMLTextAreaElement) return;
      scroller.scrollBy(
        clientRect.top + clientRect.height - (window.innerHeight - 140)
      );
    }
  }, [transcribed, wasUntranscribed]);

  const handleClick = (e: React.MouseEvent) => {
    if (e.altKey && needsCorrection && corrected) {
      viewer.updateTranscript(item.id, corrected);
      return;
    }
    if (viewer.editable && state.finish && !isEditing) {
      const width = text.current?.offsetWidth;
      setIsEditing({ width: width == null ? 0 : width + 2 });
    }
  };

  const handleSave = (newTranscript: string) => {
    viewer.updateTranscript(item.id, newTranscript);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  const listen = () => {
    const myWindow = window as { currentAudio?: HTMLAudioElement };
    const audio = (myWindow.currentAudio ??= new Audio());
    const src = viewer.getAudioUrl(item.id);
    if (!audio.paused && audio.src === src) {
      audio.pause();
    } else {
      document.body.append(audio);
      audio.src = src;
      audio.load();
      audio.currentTime = 0;
      audio.play();
    }
    const textarea = div.current?.querySelector("textarea");
    if (textarea) textarea.focus();
  };

  return (
    <div className="TranscriptItem">
      <div
        className="TranscriptItem__content"
        data-transcribed={transcribed ? "true" : "false"}
        data-editable={viewer.editable && state.finish ? "true" : "false"}
        data-editing={isEditing ? "true" : "false"}
        data-needs-correction={needsCorrection ? "true" : "false"}
        ref={div}
        onClick={handleClick}
      >
        {isEditing ? (
          <div className="d-flex">
            <EditableTranscript
              initialValue={state.transcript || ""}
              onSave={handleSave}
              onCancel={handleCancel}
              width={isEditing.width}
            />
            <div
              style={{
                position: "absolute",
                top: -2,
                right: 0,
                transform: "translateY(-100%)",
              }}
            >
              <button onClick={listen} className="btn">
                👂
              </button>
              <button onClick={handleCancel} className="btn">
                ❌
              </button>
            </div>
          </div>
        ) : (
          <div ref={text}>
            {state.transcript ?? (
              <i style={{ opacity: 0.5 }}>{partial ?? "…"}</i>
            )}{" "}
            <span className="TranscriptItem__time">{props.start}</span>
          </div>
        )}
      </div>
    </div>
  );
}
interface EditableTranscriptProps {
  initialValue: string;
  width: number;
  onSave: (newTranscript: string) => void;
  onCancel: () => void;
}

function formatTime(date: Date) {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function EditableTranscript({
  initialValue,
  onSave,
  onCancel,
  width,
}: EditableTranscriptProps) {
  const [value, setValue] = useState(initialValue);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSave(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <TextareaAutosize
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      autoFocus
      style={{
        width: width || "100%",
        border: "none",
        outline: "none",
        resize: "none",
        padding: "0",
        fontFamily: "inherit",
        fontSize: "inherit",
        letterSpacing: "inherit",
        backgroundColor: "transparent",
      }}
    />
  );
}

function TranscriptViewerOptions({ viewer }: { viewer: Viewer }) {
  const autoScroll = useStore($autoScroll);
  const toCorrect = useStore($autocorrectables).length;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Do not process keydown events when editing a text area.
      if (document.activeElement instanceof HTMLTextAreaElement) return;
      console.log(e.key);
      if (e.key === "s") {
        $autoScroll.set(!autoScroll);
      }
      if (e.key === "x") {
        document.querySelector<HTMLButtonElement>("#autoCorrectables")?.click();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="TranscriptViewerOptions">
      <div className="d-flex gap-3 align-items-center">
        <label>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={() => $autoScroll.set(!autoScroll)}
          />{" "}
          Auto-scroll
        </label>
        {viewer.editable && (
          <button
            className="btn btn-sm btn-outline-secondary"
            id="autoCorrectables"
            onClick={(e) => {
              if (e.altKey) {
                const before = $autoCorrects.get();
                const after = prompt("Autocorrects", before);
                if (after != null) {
                  $autoCorrects.set(after);
                }
              } else {
                $autocorrectables
                  .get()[0]
                  .current?.scrollIntoView({ behavior: "instant" });
              }
            }}
          >
            Autocorrect ({toCorrect})
          </button>
        )}
        <button
          className="btn btn-sm btn-outline-secondary"
          onClick={(e) => {
            const tsvContent = exportTsv(viewer);
            navigator.clipboard.writeText(tsvContent);
          }}
        >
          Copy TSV
        </button>
      </div>
    </div>
  );
}

function exportTsv(viewer: Viewer) {
  const items = viewer.$items.get();
  const tsvContent = items
    .map((item) => {
      const state = item.$state.get();
      return `${state.start}\t${state.finish}\t${state.transcript || ""}`;
    })
    .join("\n");
  return tsvContent;
}
