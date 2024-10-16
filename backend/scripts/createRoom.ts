import { adminApi } from "../src/client";

const roomInfo = await adminApi<{
  roomId: string;
  roomKey: string;
}>("/admin/rooms", { method: "POST" });

const webUrl = process.env["FRONTEND_URL_BASE"];
const backendUrl = process.env["SERVER_URL_BASE"];

console.log(JSON.stringify(roomInfo, null, 2));

console.log(`
Viewer URL:
  ${webUrl}/view?backend=${backendUrl}&room=${roomInfo.roomId}

Editor URL:
  ${webUrl}/view?backend=${backendUrl}&room=${roomInfo.roomId}&key=${roomInfo.roomKey}

Audio Sender URL:
  ${webUrl}/sender?backend=${backendUrl}&room=${roomInfo.roomId}&key=${roomInfo.roomKey}

Environment variables:
  export ROOM_ID=${roomInfo.roomId}
  export ROOM_KEY=${roomInfo.roomKey}
`);
