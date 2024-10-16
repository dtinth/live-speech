import { ofetch } from "ofetch";

export const publicApi = ofetch.create({
  baseURL: process.env["SERVER_URL_BASE"],
});

export const adminApi = publicApi.create({
  headers: {
    authorization: `Bearer ${process.env["SERVICE_TOKEN"]}`,
  },
});

export function getRoomConfig(): RoomConfig {
  const roomId = process.env["ROOM_ID"];
  const roomKey = process.env["ROOM_KEY"];

  if (!roomId) {
    throw new Error("Missing ROOM_ID");
  }
  if (!roomKey) {
    throw new Error("Missing ROOM_KEY");
  }

  return { roomId, roomKey };
}

export type RoomConfig = { roomId: string; roomKey: string };

export function createRoomApi({ roomId, roomKey }: RoomConfig) {
  return publicApi.create({
    headers: {
      authorization: `Bearer ${roomKey}`,
    },
    baseURL: `${process.env["SERVER_URL_BASE"]}/rooms/${roomId}`,
  });
}
