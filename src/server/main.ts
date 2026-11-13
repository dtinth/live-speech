import admin from "../web/admin.html";
import sender from "../web/sender.html";
import viewer from "../web/viewer.html";
import { startApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createNullPublisher, createPusherPublisher } from "./publisher.ts";
import { createFakeProvider } from "./transcription/fake.ts";
import { createQwenProvider } from "./transcription/qwen.ts";

const config = loadConfig();
const app = startApp({
  port: config.port,
  dataDir: config.dataDir,
  masterPassword: config.masterPassword,
  provider: config.provider === "qwen" ? createQwenProvider(config.qwen) : createFakeProvider(),
  publisher: config.sockudo ? createPusherPublisher(config.sockudo) : createNullPublisher(),
  sockudoClient: config.sockudo?.client ?? null,
  transcriber: { catchUpSpeed: config.catchUpSpeed },
  pages: { admin, viewer, sender },
  development: process.env.NODE_ENV !== "production",
});
console.log(`live-speech listening on ${app.url} (provider: ${config.provider}, sockudo: ${config.sockudo ? "on" : "off"})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    console.log(`${signal}: shutting down`);
    await app.stop();
    process.exit(0);
  });
}
