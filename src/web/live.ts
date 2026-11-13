import Pusher from "pusher-js";
import {
  applyEvent,
  emptyTranscript,
  type LivePartial,
  type RoomEvent,
  type TranscriptState,
} from "../shared/transcript.ts";

export interface RoomInfo {
  id: string;
  name: string;
  createdAt: number;
}

interface Snapshot {
  room: RoomInfo;
  transcript: TranscriptState;
  partials: LivePartial[];
}

type LiveMessage =
  | { kind: "event"; event: RoomEvent }
  | { kind: "partial"; seq: number; partial: LivePartial; cleared: boolean };

export type ConnectionState = "connecting" | "live" | "polling" | "offline";

export interface LiveRoomState {
  room: RoomInfo | null;
  transcript: TranscriptState;
  partials: Record<string, LivePartial>;
  connection: ConnectionState;
  error: string | null;
}

/**
 * Keeps a room's transcript current in the browser.
 *
 * Loads a snapshot over HTTP, then applies events pushed by Sockudo strictly
 * in seq order. Anything out of order, a reconnect, or a periodic safety check
 * triggers a catch-up fetch of the events since our seq, so missed pushes
 * (including during our own server's redeploys) never leave holes. Without
 * Sockudo it simply polls.
 */
export class LiveRoom {
  state: LiveRoomState = {
    room: null,
    transcript: emptyTranscript(),
    partials: {},
    connection: "connecting",
    error: null,
  };
  private listeners = new Set<() => void>();
  private pusher: Pusher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private catchingUp: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly roomId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private update(patch: Partial<LiveRoomState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start() {
    try {
      await this.loadSnapshot();
    } catch (error) {
      this.update({ error: (error as Error).message, connection: "offline" });
      // Keep trying: the server may be mid-redeploy.
      setTimeout(() => !this.disposed && this.start(), 3000);
      return;
    }
    const config = (await fetch("/api/config").then((r) => r.json())) as {
      sockudo: { key: string; wsHost: string; wsPort: number; forceTLS: boolean } | null;
    };
    if (config.sockudo) {
      this.connectSockudo(config.sockudo);
      this.timer = setInterval(() => this.catchUp(), 15000);
    } else {
      this.update({ connection: "polling" });
      this.timer = setInterval(() => this.catchUp(), 1000);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.pusher?.disconnect();
  }

  private async loadSnapshot() {
    const res = await fetch(`/api/rooms/${this.roomId}`);
    if (res.status === 404) throw new Error("This room does not exist.");
    if (!res.ok) throw new Error(`Could not load the room (${res.status}).`);
    const snapshot = (await res.json()) as Snapshot;
    this.update({
      room: snapshot.room,
      transcript: snapshot.transcript,
      partials: Object.fromEntries(snapshot.partials.map((p) => [p.streamId, p])),
      error: null,
    });
  }

  private connectSockudo(config: { key: string; wsHost: string; wsPort: number; forceTLS: boolean }) {
    const pusher = new Pusher(config.key, {
      cluster: "",
      wsHost: config.wsHost,
      wsPort: config.wsPort,
      wssPort: config.wsPort,
      forceTLS: config.forceTLS,
      enabledTransports: ["ws", "wss"],
      disableStats: true,
    });
    this.pusher = pusher;
    pusher.connection.bind("state_change", ({ current }: { current: string }) => {
      if (current === "connected") {
        this.update({ connection: "live" });
        // We may have missed events while disconnected.
        void this.catchUp();
      } else if (current === "connecting") {
        this.update({ connection: "connecting" });
      } else {
        this.update({ connection: "offline" });
      }
    });
    const channel = pusher.subscribe(`room-${this.roomId}`);
    channel.bind("event", (message: LiveMessage & { kind: "event" }) => this.receiveEvent(message.event));
    channel.bind("partial", (message: LiveMessage & { kind: "partial" }) => this.receivePartial(message));
  }

  private receiveEvent(event: RoomEvent) {
    const seq = this.state.transcript.seq;
    if (event.seq <= seq) return;
    if (event.seq !== seq + 1) {
      void this.catchUp();
      return;
    }
    this.applyEvents([event]);
  }

  private receivePartial(message: { seq: number; partial: LivePartial; cleared: boolean }) {
    const partials = { ...this.state.partials };
    if (message.cleared) delete partials[message.partial.streamId];
    else partials[message.partial.streamId] = message.partial;
    this.update({ partials });
    if (message.seq > this.state.transcript.seq) void this.catchUp();
  }

  private applyEvents(events: RoomEvent[]) {
    if (events.length === 0) return;
    // Copy-on-write so React sees a new object.
    const transcript: TranscriptState = structuredClone(this.state.transcript);
    for (const event of events) {
      if (event.seq === transcript.seq + 1) applyEvent(transcript, event);
    }
    const partials = { ...this.state.partials };
    for (const event of events) {
      // A finished segment replaces its stream's partial.
      if (event.type === "segment.final") delete partials[event.streamId];
    }
    this.update({ transcript, partials });
  }

  /** Fetches and applies every event after our seq. Concurrent calls share one fetch. */
  catchUp(): Promise<void> {
    this.catchingUp ??= (async () => {
      try {
        for (;;) {
          const res = await fetch(`/api/rooms/${this.roomId}/events?after=${this.state.transcript.seq}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { events: RoomEvent[]; seq: number; partials: LivePartial[] };
          this.applyEvents(body.events);
          if (this.state.connection === "polling" || body.events.length === 0) {
            this.update({ partials: Object.fromEntries(body.partials.map((p) => [p.streamId, p])) });
          }
          if (this.state.transcript.seq >= body.seq) break;
        }
        if (this.state.error) this.update({ error: null });
        if (!this.pusher && this.state.connection !== "polling") this.update({ connection: "polling" });
      } catch {
        if (!this.pusher) this.update({ connection: "offline" });
      } finally {
        this.catchingUp = null;
      }
    })();
    return this.catchingUp;
  }
}
