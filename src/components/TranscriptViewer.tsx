import { useStore } from "@nanostores/react";
import { atom, type WritableAtom } from "nanostores";
import { ofetch } from "ofetch";
import ReconnectingWebSocket from "reconnecting-websocket";

export function TranscriptViewer() {
  const params = new URLSearchParams(window.location.search);

  const room = params.get("room");
  if (!room) {
    return "Need room";
  }

  return <TranscriptViewerView room={room} />;
}

function createViewer(room: string) {
  const ws = new ReconnectingWebSocket(
    `ws://localhost:10300/rooms/${room}/publicEvents`
  );
  const bufferedPartial = new Map<string, string>();
  ws.onmessage = async (e) => {
    const json = JSON.parse(e.data);
    console.log(json);
    if (json.method === "updated") {
      const id = json.params.id;
      const state = await ofetch<ItemState>(
        `http://localhost:10300/rooms/${room}/items/${id}`
      );
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
      `http://localhost:10300/rooms/${room}/items`
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

function TranscriptViewerView(props: { room: string }) {
  const viewer = (_viewer ??= createViewer(props.room));
  const items = useStore(viewer.$items);
  return (
    <div>
      <h1>Transcript for room {props.room}</h1>
      <div
        style={{
          fontFamily: "Sarabun, sans-serif",
          letterSpacing: "0.1ch",
          fontSize: "20px",
          paddingBottom: "50vh",
        }}
      >
        {items.map((item) => {
          return <TranscriptItem key={item.id} item={item} />;
        })}
      </div>
    </div>
  );
}

function TranscriptItem(props: { item: ViewerTranscriptItem }) {
  const { item } = props;
  const state = useStore(item.$state);
  const partial = useStore(item.$partial);
  return (
    <div className="mb-2 d-flex">
      <div
        className={"p-3 rounded border"}
        style={{ borderColor: state.transcript ? undefined : "transparent" }}
      >
        {state.transcript ?? <i style={{ opacity: 0.5 }}>{partial ?? "…"}</i>}
      </div>
    </div>
  );
}
