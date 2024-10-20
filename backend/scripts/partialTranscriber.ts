import { protos, v2 } from "@google-cloud/speech";
import { spawn } from "child_process";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ofetch } from "ofetch";
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
  return async function* (source: AsyncIterable<Uint8Array>) {
    Readable.from(source).pipe(child.stdin);
    for await (const line of parseNdjson(child.stdout)) {
      yield line;
    }
    child.kill();
  };
}

function createGoogleTranscriber(language: string, signal: AbortSignal) {
  const client = new v2.SpeechClient();
  const stream = client._streamingRecognize();
  const createRequest = (
    x: protos.google.cloud.speech.v2.IStreamingRecognizeRequest
  ) => x;
  return async function* (source: AsyncIterable<Uint8Array>) {
    const inputStream = Readable.from(
      (async function* () {
        yield createRequest({
          recognizer:
            "projects/dtinth-audio-transcription/locations/global/recognizers/_",
          streamingConfig: {
            config: {
              explicitDecodingConfig: {
                encoding: "LINEAR16",
                sampleRateHertz: 16000,
                audioChannelCount: 1,
              },
              languageCodes: [language],
              model: "short",
            },
            streamingFeatures: {
              interimResults: true,
            },
          },
        });
        for await (const chunk of source) {
          yield createRequest({ audio: chunk });
        }
      })()
    );
    inputStream.pipe(stream);
    for await (const event of stream) {
      const text = event?.results?.[0]?.alternatives?.[0]?.transcript;
      if (text) {
        yield { text };
      } else {
        console.warn("No text in event", JSON.stringify(event));
      }
    }
  };
}

let cachedSpeechmaticsApiKey: string | undefined;
async function obtainSpeechamticsApiKey() {
  if (cachedSpeechmaticsApiKey) return cachedSpeechmaticsApiKey;

  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) {
    throw new Error("SPEECHMATICS_API_KEY environment variable is not set");
  }

  const refresh = async () => {
    const response = await ofetch<{ key_value: string }>(
      "https://mp.speechmatics.com/v1/api_keys?type=rt",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ttl: 3600 }),
      }
    );
    cachedSpeechmaticsApiKey = response.key_value;
    return response.key_value;
  };
  setInterval(refresh, 1800 * 1000);
  return await refresh();
}

function createSpeechmaticsTranscriber(language: string, signal: AbortSignal) {
  const output = new PassThrough({ objectMode: true });
  async function worker(source: AsyncIterable<Uint8Array>) {
    const tempKey = await obtainSpeechamticsApiKey();
    const socket = new WebSocket(
      `wss://eu2.rt.speechmatics.com/v2?jwt=${tempKey}`
    );
    const openPromise = new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        console.log("Connected to Speechmatics WebSocket");
        const startMessage = {
          message: "StartRecognition",
          audio_format: {
            type: "raw",
            encoding: "pcm_s16le",
            sample_rate: 16000,
          },
          transcription_config: {
            language,
            enable_partials: true,
          },
        };
        socket.send(JSON.stringify(startMessage));
        resolve();
      };
      socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        output.write(data);
        if (data.message === "EndOfTranscript") {
          socket.close();
          output.end();
        }
      };
      socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        reject();
        output.end();
      };
      socket.onclose = (event) => {
        console.log("WebSocket closed:", event.code, event.reason);
        output.end();
      };
    });
    await openPromise;
    let nChunks = 0;
    for await (const chunk of source) {
      socket.send(chunk);
      nChunks += 1;
    }
    socket.send(
      JSON.stringify({ message: "EndOfStream", last_seq_no: nChunks })
    );
  }

  return async function* (source: AsyncIterable<Uint8Array>) {
    const promise = worker(source);
    for await (const item of output) {
      if (
        item.message === "AddTranscript" ||
        item.message === "AddPartialTranscript"
      ) {
        const text = String(item.metadata?.transcript || "")
          .replace(/<\w+>/g, "")
          .trim();
        if (text) {
          yield { text };
        }
      }
    }
    await promise;
  };
}

async function* parseNdjson(source: any) {
  for await (const line of createInterface({ input: Readable.from(source) })) {
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
        process.env["PARTIAL_TRANSCRIBER_PROVIDER"] === "speechmatics"
          ? createSpeechmaticsTranscriber(process.env['TRANSCRIBER_LANG'] || "th", this.abortController.signal)
          : process.env["PARTIAL_TRANSCRIBER_PROVIDER"] === "local"
          ? createTranscriber("th", false, this.abortController.signal)
          : createGoogleTranscriber("th-TH", this.abortController.signal),
        async (source) => {
          for await (const { text } of source) {
            console.log("   -", text);
            websocket.send(
              JSON.stringify({
                method: "submit_partial_transcript",
                params: {
                  id: this.id,
                  transcript: text,
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
      if (currentTranscription) {
        currentTranscription.finish();
        currentTranscription = undefined;
      }
      break;
    }
  }
};
