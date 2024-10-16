import { uuidv7 } from "uuidv7";
import { db } from "./db";
import { pubsub } from "./pubsub";
import type { Room } from "./room";

export class Utterance {
  id = uuidv7();
  start = new Date().toISOString();
  buffers: Buffer[] = [];

  constructor(public room: Room) {
    pubsub.publish(room.audioTopic, "audio_start", { id: this.id });
    db.roomItems(this.room).set(this.id, {
      start: this.start,
    });
    pubsub.publish(`public/${room}`, "updated", { id: this.id });
  }
  addAudio(base64: string) {
    this.buffers.push(Buffer.from(base64, "base64"));
    pubsub.publish(this.room.audioTopic, "audio_data", { id: this.id, base64 });
  }
  finish() {
    pubsub.publish(this.room.name, "audio_finish", { id: this.id });
    const buffer = Buffer.concat(this.buffers);
    db.roomItems(this.room).set(this.id, {
      start: this.start,
      finish: new Date().toISOString(),
      length: buffer.length,
    });
    db.audio.set(this.id, buffer.toString("base64"));
    pubsub.publish(`public/${this.room}`, "updated", { id: this.id });
  }
}
