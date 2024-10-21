import Groq from "groq-sdk";
import { uuidv7 } from "uuidv7";
import { createRoomApi, getRoomConfig, publicApi } from "../src/client";

const groq = new Groq();
const api = createRoomApi(getRoomConfig());

let waiting = false;
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

  const modelName = "whisper-large-v3";
  const transcription = await groq.audio.translations.create({
    file: new File([await loadAudio(untranscribed[0].id)], "audio.wav"),
    model: modelName,
    response_format: "json",
  });
  console.log(transcription.text);
  const usageId = uuidv7();
  await api(`/items/${untranscribed[0].id}`, {
    method: "PATCH",
    body: {
      transcript: transcription.text,
      transcriptBy: modelName,
      usageId,
    },
  });
  return true;
}

async function loadAudio(id: string) {
  return publicApi(`/pcm/${id}`, { responseType: "blob" }).then((r) =>
    r.arrayBuffer()
  );
}

const initialHp = 5;
let hp = initialHp;
for (;;) {
  try {
    if (!(await main())) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (hp < initialHp) {
      hp = initialHp;
      console.error("HP has been restored to", hp);
    }
  } catch (error) {
    console.error(error);
    hp--;
    if (hp <= 0) {
      console.error("Giving up");
      process.exit(1);
      break;
    } else {
      console.error("HP has been reduced to", hp);
    }
  } finally {
    await new Promise((r) => setTimeout(r, 100));
  }
}
