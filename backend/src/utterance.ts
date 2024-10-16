import { uuidv7 } from "uuidv7";
import { db } from "./db";
import { updateItem } from "./itemOperations";
import { pubsub } from "./pubsub";
import type { Room } from "./room";

export class Utterance {
  id = uuidv7();
  start = new Date().toISOString();
  buffers: Buffer[] = [];

  constructor(public room: Room) {
    pubsub.publish(room.audioTopic, "audio_start", { id: this.id });
    updateItem(room, this.id, { start: this.start });
  }
  addAudio(base64: string) {
    this.buffers.push(Buffer.from(base64, "base64"));
    pubsub.publish(this.room.audioTopic, "audio_data", { id: this.id, base64 });
  }
  async finish() {
    pubsub.publish(this.room.name, "audio_finish", { id: this.id });
    const buffer = Buffer.concat(this.buffers);
    await db.audio.set(this.id, buffer.toString("base64"));
    await updateItem(this.room, this.id, {
      finish: new Date().toISOString(),
      length: buffer.length,
    });
  }
}
