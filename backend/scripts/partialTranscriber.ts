import { spawn } from "child_process";
import { createInterface } from "node:readline";
import { Duplex, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import ReconnectingWebSocket from "reconnecting-websocket";
import { getRoomConfig } from "../src/client";

const roomConfig = getRoomConfig();

const websocket = new ReconnectingWebSocket(
  `${process.env["SERVER_URL_BASE"]!.replace(/^http/, "ws")}/rooms/${
    roomConfig.roomId
  }/audioEvents?key=${roomConfig.roomKey}`
);

function isAbortError(e: any) {
  return e.name === "AbortError";
}

function createTranscriber(
  language: string,
  requireOnDevice: boolean,
  signal: AbortSignal
) {
  const child = spawn("transcriber", [language], {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ...(requireOnDevice ? { TRANSCRIBE_ON_DEVICE_ONLY: "1" } : {}),
    },
    signal,
  });
  child.on("error", (error) => {
    if (isAbortError(error)) return;
    console.error("Transcriber process encountered error", error);
  });
  return Duplex.from({
    writable: child.stdin,
    readable: child.stdout,
  });
}

async function* parseNdjson(source: NodeJS.ReadableStream) {
  for await (const line of createInterface({ input: source })) {
    if (line.trim()) {
      yield JSON.parse(line);
    }
  }
}

let currentTranscription: Transcription | undefined;

class Transcription {
  abortController: AbortController;
  input = new PassThrough();
  constructor(public id: string) {
    this.abortController = new AbortController();
    this.worker();
    console.log("*", id);
  }
  addAudio(buffer: Buffer) {
    this.input.write(buffer);
  }
  async worker() {
    try {
      await pipeline(
        this.input,
        new PassThrough(),
        createTranscriber("th", false, this.abortController.signal),
        async (source) => {
          for await (const event of parseNdjson(
            source as NodeJS.ReadableStream
          )) {
            console.log("   -", event.text, event.isFinal);
            websocket.send(
              JSON.stringify({
                method: "submit_partial_transcript",
                params: {
                  id: this.id,
                  transcript: event.text,
                },
              })
            );
          }
        }
      );
    } catch (error) {
      console.error(`Worker ${this.id} error`, error);
    }
  }
  finish() {
    this.input.end();
    setTimeout(() => {
      this.abortController.abort();
    }, 3000);
  }
}

websocket.onopen = () => {
  console.log("Connected to backend");
};
websocket.onclose = () => {
  console.error("Disconnected from backend");
};
websocket.onmessage = (e) => {
  const data = JSON.parse(e.data);
  switch (data.method) {
    case "audio_start": {
      if (currentTranscription) {
        currentTranscription.finish();
        currentTranscription = undefined;
      }
      currentTranscription = new Transcription(data.params.id);
      break;
    }
    case "audio_data": {
      if (currentTranscription && currentTranscription.id !== data.params.id) {
        currentTranscription.finish();
        currentTranscription = undefined;
      }
      if (!currentTranscription) {
        currentTranscription = new Transcription(data.params.id);
      }
      currentTranscription.addAudio(Buffer.from(data.params.base64, "base64"));
      break;
    }
    case "audio_finish": {
      break;
    }
  }
};
