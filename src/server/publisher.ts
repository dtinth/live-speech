import { createHash, createHmac } from "node:crypto";

/** Pushes room updates to viewers. Viewers never talk to our server for this. */
export interface Publisher {
  publish(channel: string, event: string, data: unknown): Promise<void>;
}

/** Channel a room's viewers subscribe to. */
export function roomChannel(roomId: string) {
  return `room-${roomId}`;
}

export interface PusherConfig {
  /** e.g. http://127.0.0.1:6001 */
  apiUrl: string;
  appId: string;
  key: string;
  secret: string;
}

/**
 * Publishes over the Pusher HTTP API, which Sockudo implements. Failures are
 * logged, not thrown: viewers recover any missed event from the HTTP API.
 */
export function createPusherPublisher(config: PusherConfig): Publisher {
  return {
    async publish(channel, event, data) {
      const body = JSON.stringify({ name: event, channel, data: JSON.stringify(data) });
      const path = `/apps/${config.appId}/events`;
      const params = new URLSearchParams({
        auth_key: config.key,
        auth_timestamp: String(Math.floor(Date.now() / 1000)),
        auth_version: "1.0",
        body_md5: createHash("md5").update(body).digest("hex"),
      });
      const query = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      const signature = createHmac("sha256", config.secret).update(`POST\n${path}\n${query}`).digest("hex");
      try {
        const res = await fetch(`${config.apiUrl}${path}?${query}&auth_signature=${signature}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) console.error(`[publisher] ${res.status} ${await res.text()}`);
      } catch (error) {
        console.error("[publisher]", error);
      }
    },
  };
}

export function createNullPublisher(): Publisher {
  return { async publish() {} };
}
