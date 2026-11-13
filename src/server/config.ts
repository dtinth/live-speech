import type { QwenConfig } from "./transcription/qwen.ts";

export interface SockudoClientConfig {
  key: string;
  wsHost: string;
  wsPort: number;
  forceTLS: boolean;
}

export interface Config {
  port: number;
  dataDir: string;
  masterPassword: string;
  provider: "fake" | "qwen";
  qwen: QwenConfig;
  sockudo: { apiUrl: string; appId: string; key: string; secret: string; client: SockudoClientConfig } | null;
  catchUpSpeed: number;
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): Config {
  // Treat empty values (as left in .env.example) as unset.
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const masterPassword = env.MASTER_PASSWORD ?? "";
  if (!masterPassword) throw new Error("MASTER_PASSWORD must be set");
  const provider = (env.TRANSCRIPTION_PROVIDER ?? (env.DASHSCOPE_API_KEY ? "qwen" : "fake")) as Config["provider"];
  if (provider !== "fake" && provider !== "qwen") throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${provider}`);
  if (provider === "qwen" && !env.DASHSCOPE_API_KEY) throw new Error("DASHSCOPE_API_KEY must be set for qwen");

  let sockudo: Config["sockudo"] = null;
  if (env.SOCKUDO_API_URL && env.SOCKUDO_APP_ID && env.SOCKUDO_KEY && env.SOCKUDO_SECRET) {
    const wsUrl = new URL(env.SOCKUDO_WS_URL ?? env.SOCKUDO_API_URL);
    const tls = wsUrl.protocol === "https:" || wsUrl.protocol === "wss:";
    sockudo = {
      apiUrl: env.SOCKUDO_API_URL.replace(/\/$/, ""),
      appId: env.SOCKUDO_APP_ID,
      key: env.SOCKUDO_KEY,
      secret: env.SOCKUDO_SECRET,
      client: {
        key: env.SOCKUDO_KEY,
        wsHost: wsUrl.hostname,
        wsPort: Number(wsUrl.port || (tls ? 443 : 80)),
        forceTLS: tls,
      },
    };
  }

  const price = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number ≥ 0`);
    return value;
  };
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID;

  return {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? "./data",
    masterPassword,
    provider,
    qwen: {
      apiKey: env.DASHSCOPE_API_KEY ?? "",
      model: env.QWEN_MODEL ?? "qwen-audio-3.1-asr-flash-streaming",
      url:
        env.QWEN_URL ??
        (workspaceId
          ? `wss://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`
          : "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference"),
      workspaceId,
      languageHints: (env.QWEN_LANGUAGE ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // Model Studio's international list prices for qwen-audio-3.1-asr-flash-streaming, 2026-11.
      inputPerMillionUsd: price("QWEN_INPUT_PRICE_PER_MILLION_USD", 0.93),
      outputPerMillionUsd: price("QWEN_OUTPUT_PRICE_PER_MILLION_USD", 0.7),
    },
    sockudo,
    catchUpSpeed: Number(env.CATCHUP_SPEED ?? 1.5),
  };
}
