import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
  type GenerationConfig,
  type Part,
  type UsageMetadata,
} from "@google/generative-ai";
import { createHash } from "crypto";
import { uuidv7 } from "uuidv7";
import { createRoomApi, getRoomConfig, publicApi } from "../src/client";

const api = createRoomApi(getRoomConfig());

const apiKey = process.env["GEMINI_API_KEY"]!;
const genAI = new GoogleGenerativeAI(apiKey);
export const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash-002",
});

interface HistoryItem {
  audio: ArrayBuffer;
  transcript: string;
}

let waiting = false;

export interface TranscriptionItem {
  id: string;
  transcript: string;
}

export async function processAudio(
  audio: ArrayBuffer[],
  history: HistoryItem[] = [],
  prior: string[] = []
) {
  const generationConfig: GenerationConfig = {
    maxOutputTokens: 300,
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        transcription: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: { type: SchemaType.STRING },
              transcript: { type: SchemaType.STRING },
            },
          },
        },
      },
    },
  };
  const historyParts: Part[] = [
    {
      text:
        `You are a professional transcriber. You will be given a series of audio files and their IDs in this format:

id: <id>
<audio file>

Transcribe the speech in each audio file.

Style guide:
- For English words, if it is a common word, then spell it using lowercase (e.g. oscillator). If it is a proper noun, capitalize it properly (e.g. Google Chrome). If it's an API name or part of computer code, use verbatim capitalization (e.g. getElementById).
- For Thai text, do not add a space between words. Only add spaces between sentences or when there is obvious pausing.
- For technical terms, in general, spell it in English (e.g. canvas, vertex, scene). Only transliterate it to Thai if it is a very common word and commonly spelled in Thai (e.g. ลิงก์, เคส, อัพเกรด, โปรแกรมเมอร์).
- Remove filler words like "umm" and "ah". Also fix the transcript when the speaker corrects themselves or repeats themselves due to stuttering.
- At the end of the audio file there may be beeping sound, do not include it in the transcript.
- If there is no speech, return an empty string for the transcript.` +
        (prior.length > 0
          ? `

Prior transcriptions: ${JSON.stringify(prior)}\n\n`
          : "") +
        `

Transcribe the following audio files.`,
    },
  ];
  const expected: TranscriptionItem[] = [];
  for (const item of history) {
    const buffer = Buffer.from(item.audio);
    const id = createHash("md5").update(buffer).digest("hex").slice(0, 6);
    historyParts.push({ text: "id: " + id });
    historyParts.push({
      inlineData: {
        mimeType: "audio/x-m4a",
        data: buffer.toString("base64"),
      },
    });
    expected.push({ id, transcript: item.transcript });
  }
  console.log(historyParts);
  const chatSession = model.startChat({
    generationConfig: generationConfig,
    history: [
      {
        role: "user",
        parts: historyParts,
      },
      {
        role: "model",
        parts: [{ text: JSON.stringify({ transcription: expected }) }],
      },
    ],
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
  });

  const promptParts: Part[] = [];
  const ids: string[] = [];
  for (const item of audio) {
    const buffer = Buffer.from(item);
    const id = createHash("md5").update(buffer).digest("hex").slice(0, 6);
    ids.push(id);
    promptParts.push({ text: "id: " + id });
    promptParts.push({
      inlineData: {
        mimeType: "audio/x-m4a",
        data: buffer.toString("base64"),
      },
    });
  }

  const result = await chatSession.sendMessageStream(promptParts, {
    timeout: 5000,
  });
  let usageMetadata: UsageMetadata | undefined;
  let text = "";
  let error = "";
  try {
    for await (const chunk of result.stream) {
      if (chunk.usageMetadata) {
        usageMetadata = chunk.usageMetadata;
      }
      text += chunk.text();
    }
  } catch (e: any) {
    // Add emoji to signify error
    text += "❌";
    console.error("[processAudio]", e);
    error = String(e?.stack || e);
    // ctx.log("error", { error });
  }
  return { usageMetadata, text, error, ids };
}

function postProcess(text: string) {
  return text
    .replace(/ปื๊ด\s*$/, "")
    .replace(/ปื้ด\s*$/, "")
    .replace(/ปี๊บๆ+\s*$/, "")
    .replace(/ๆ(?:ๆ+)\s*$/, "ๆ")
    .trim();
}

async function main() {
  const list = await api<
    {
      id: string;
      start: string;
      finish: string;
      length: number;
      transcript?: string;
    }[]
  >(`/items`);

  const validItems = list.filter((item) => item.length > 0);
  validItems.sort((a, b) => a.start.localeCompare(b.start));

  const untranscribed = validItems.filter((item) => item.transcript == null);
  if (!untranscribed.length) {
    if (!waiting) {
      waiting = true;
      process.stderr.write("Waiting for transcription...");
    } else {
      process.stderr.write(".");
    }
    return false;
  }
  if (waiting) {
    process.stderr.write("\n");
    waiting = false;
  }
  const allBefore = validItems.filter(
    (item) => item.start < untranscribed[0].start
  );
  const before = allBefore.slice(-3);
  const prior = allBefore
    .slice(0, -3)
    .flatMap((r) => (r.transcript ? [r.transcript] : []))
    .slice(-37);
  const history = await Promise.all(
    before.map(async (item) => {
      const audio = await loadAudio(item.id);
      return { audio, transcript: item.transcript! };
    })
  );
  const audio = await Promise.all(
    untranscribed.slice(0, 3).map((item) => loadAudio(item.id))
  );
  const result = await processAudio(audio, history, prior);
  let { transcription } = JSON.parse(result.text) as {
    transcription: TranscriptionItem[];
  };
  const usageId = uuidv7();
  for (const [i, item] of transcription.entries()) {
    if (result.ids[i] !== item.id) {
      console.warn(
        "Prompt ID mismatch, expected",
        item.id,
        "but received",
        result.ids[i]
      );
      continue;
    }
    const { id } = untranscribed[i];
    const transcript = postProcess(item.transcript);
    console.log(`${id} => ${JSON.stringify(transcript)}`);
    await api(`/items/${id}`, {
      method: "PATCH",
      body: {
        transcript,
        transcriptBy: "gemini",
        usageMetadata: result.usageMetadata,
        usageId: usageId,
      },
    });
  }
  return true;
}

async function loadAudio(id: string) {
  return publicApi(`/pcm/${id}`, { responseType: "blob" }).then((r) =>
    r.arrayBuffer()
  );
}

for (;;) {
  try {
    if (!(await main())) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (error) {
    console.error(error);
  } finally {
    await new Promise((r) => setTimeout(r, 100));
  }
}
