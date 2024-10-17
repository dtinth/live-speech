import { useStore } from "@nanostores/react";
import { atom, type WritableAtom } from "nanostores";
import { ofetch } from "ofetch";
import { useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import ReconnectingWebSocket from "reconnecting-websocket";
import type { BackendContext } from "../BackendContext";

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
      <div
        style={{
          fontFamily: "Sarabun, sans-serif",
          letterSpacing: "0.1ch",
          fontSize: "20px",
          paddingBottom: "75vh",
        }}
      >
        {items.map((item) => {
          return <TranscriptItem key={item.id} item={item} viewer={viewer} />;
        })}
      </div>
    </div>
  );
}

function TranscriptItem(props: { item: ViewerTranscriptItem; viewer: Viewer }) {
  const div = useRef<HTMLDivElement>(null);
  const { item, viewer } = props;
  const state = useStore(item.$state);
  const partial = useStore(item.$partial);
  const [isEditing, setIsEditing] = useState<false | { width: number }>(false);

  const handleClick = () => {
    if (viewer.editable && state.finish && !isEditing) {
      setIsEditing({ width: div.current?.offsetWidth ?? 0 });
    }
  };

  const handleSave = (newTranscript: string) => {
    viewer.updateTranscript(item.id, newTranscript);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  return (
    <div className="mb-2 d-flex">
      <div
        className={"p-3 rounded border"}
        style={{
          borderColor: state.transcript ? undefined : "transparent",
          cursor: viewer.editable && state.finish ? "pointer" : "default",
        }}
        ref={div}
        onClick={handleClick}
      >
        {isEditing ? (
          <EditableTranscript
            initialValue={state.transcript || ""}
            onSave={handleSave}
            onCancel={handleCancel}
            width={isEditing.width}
          />
        ) : (
          state.transcript ?? <i style={{ opacity: 0.5 }}>{partial ?? "…"}</i>
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
      onBlur={() => onSave(value)}
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
