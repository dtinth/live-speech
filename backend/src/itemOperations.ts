import { db } from "./db";
import { publicBroadcast } from "./publicBroadcast";
import { Room } from "./room";

export async function getItems(room: Room) {
  const output = [];
  for await (const [id, data] of db.roomItems(room)) {
    if (typeof data !== "object") {
      console.error("Invalid item", id);
    } else {
      output.push({ id, ...data });
    }
  }
  return output;
}

export async function getItem(room: Room, id: string) {
  const item = await db.roomItems(room).get(id);
  return item ? { ...item, id } : null;
}

export async function updateItem(room: Room, id: string, changes: any) {
  const existingItem = (await db.roomItems(room).get(id)) || {};
  const newValue = {
    ...existingItem,
    ...changes,
    changes: [
      ...(existingItem?.changes ?? []),
      { payload: changes, time: new Date().toISOString() },
    ],
  };
  await db.roomItems(room).set(id, newValue);
  publicBroadcast(room, "updated", { ...newValue, id });
  return newValue;
}
