import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
  type Content,
  type GenerationConfig,
  type UsageMetadata,
} from "@google/generative-ai";
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

export async function processAudio(
  audio: ArrayBuffer,
  history: HistoryItem[] = []
) {
  const generationConfig: GenerationConfig = {
    maxOutputTokens: Math.min(8192, 300),
    responseMimeType: "application/json",
    responseSchema: {
      type: SchemaType.OBJECT,
      properties: {
        transcript: { type: SchemaType.STRING },
      },
    },
  };
  const chatSession = model.startChat({
    generationConfig: generationConfig,
    history: [
      ...history.flatMap((item): Content[] => {
        return [
          {
            role: "user",
            parts: [
              { text: "Say exactly what you hear." },
              {
                inlineData: {
                  mimeType: "audio/x-m4a",
                  data: Buffer.from(item.audio).toString("base64"),
                },
              },
            ],
          },
          {
            role: "model",
            parts: [{ text: JSON.stringify({ transcript: item.transcript }) }],
          },
        ];
      }),
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
  const result = await chatSession.sendMessageStream([
    { text: "Say exactly what you hear." },
    {
      inlineData: {
        mimeType: "audio/x-m4a",
        data: Buffer.from(audio).toString("base64"),
      },
    },
  ]);
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
  return { usageMetadata, text, error };
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

  const untranscribed = validItems.find((item) => item.transcript == null);
  if (!untranscribed) {
    console.log("All transcribed!");
    return;
  }
  const before = validItems
    .filter((item) => item.start < untranscribed.start)
    .slice(-5);

  const history = await Promise.all(
    before.map(async (item) => {
      const audio = await loadAudio(item.id);
      return { audio, transcript: item.transcript! };
    })
  );
  const audio = await loadAudio(untranscribed.id);
  const result = await processAudio(audio, history);
  console.log(result);
  let { transcript } = JSON.parse(result.text) as { transcript: string };
  transcript = postProcess(transcript);
  await api(`/items/${untranscribed.id}`, {
    method: "PATCH",
    body: {
      transcript,
      transcriptBy: "gemini",
      usageMetadata: result.usageMetadata,
    },
  });
}

async function loadAudio(id: string) {
  return publicApi(`/pcm/${id}`, { responseType: "blob" }).then((r) =>
    r.arrayBuffer()
  );
}

for (;;) {
  await main();
  await new Promise((r) => setTimeout(r, 500));
}
