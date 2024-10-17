import chalk from "chalk";
import { adminApi } from "../src/client";

const roomInfo = await adminApi<{
  roomId: string;
  roomKey: string;
}>("/admin/rooms", { method: "POST" });

const webUrl = process.env["FRONTEND_URL_BASE"];
const backendUrl = process.env["SERVER_URL_BASE"];

console.log(JSON.stringify(roomInfo, null, 2));

console.log(`
${chalk.yellow.bold("Viewer URL:")}
${webUrl}/view?backend=${backendUrl}&room=${roomInfo.roomId}

${chalk.yellow.bold("Editor URL:")}
${webUrl}/view?backend=${backendUrl}&room=${roomInfo.roomId}&key=${
  roomInfo.roomKey
}

${chalk.yellow.bold("Audio Sender URL:")}
${webUrl}/sender?backend=${backendUrl}&room=${roomInfo.roomId}&key=${
  roomInfo.roomKey
}

${chalk.bold("env:")}
SERVER_URL_BASE=${backendUrl}
ROOM_ID=${roomInfo.roomId}
ROOM_KEY=${roomInfo.roomKey}
`);
