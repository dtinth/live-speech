import { uuidv7 } from "uuidv7";
import { db } from "./db";
import { pubsub } from "./pubsub";
import type { Room } from "./room";

export function publicBroadcast(room: Room, method: string, params: any) {
  pubsub.publish(room.publicTopic, method, params);
  db.roomLogs(room).set(uuidv7(), {
    time: new Date().toISOString(),
    method,
    params,
  });
}
