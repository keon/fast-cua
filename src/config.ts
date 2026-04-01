import type { AppConfig, ExecutorConfig } from "./types.js";

const DEFAULT_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
const DEFAULT_INTERVAL_SECONDS = 0.5;
const DEFAULT_CAPTURE_FPS = 4;
const DEFAULT_ICE_URLS = ["stun:stun.l.google.com:19302"];

function parseInterval(value: string | undefined): number {
  const intervalSeconds = value ? Number(value) : DEFAULT_INTERVAL_SECONDS;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0.1) {
    throw new Error("DEFAULT_INTERVAL_SECONDS must be a number >= 0.1.");
  }
  return intervalSeconds;
}

function parseCaptureFps(value: string | undefined): number {
  const captureFps = value ? Number(value) : DEFAULT_CAPTURE_FPS;
  if (!Number.isFinite(captureFps) || captureFps <= 0) {
    throw new Error("CAPTURE_FPS must be a positive number.");
  }
  return captureFps;
}

function loadExecutorConfig(): ExecutorConfig {
  const type = process.env.ACTION_EXECUTOR_TYPE ?? "macos_native";
  if (type === "mock") {
    return { type: "mock" };
  }

  if (type === "macos_native") {
    return { type: "macos_native" };
  }

  if (type === "webhook") {
    const url = process.env.ACTION_WEBHOOK_URL;
    if (!url) {
      throw new Error("ACTION_WEBHOOK_URL is required when ACTION_EXECUTOR_TYPE=webhook.");
    }
    return {
      type: "webhook",
      url,
    };
  }

  throw new Error(`Unsupported ACTION_EXECUTOR_TYPE: ${type}`);
}

function loadIceUrls(): string[] {
  const raw = process.env.WEBRTC_ICE_URLS;
  if (!raw) {
    return DEFAULT_ICE_URLS;
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const overshootApiKey = process.env.OVERSHOOT_API_KEY;
  if (!overshootApiKey) {
    throw new Error("OVERSHOOT_API_KEY is required.");
  }

  return {
    defaultModel: process.env.DEFAULT_MODEL ?? DEFAULT_MODEL,
    defaultIntervalSeconds: parseInterval(process.env.DEFAULT_INTERVAL_SECONDS),
    defaultExecutor: loadExecutorConfig(),
    overshootApiKey,
    overshootApiUrl: process.env.OVERSHOOT_API_URL,
    captureFps: parseCaptureFps(process.env.CAPTURE_FPS),
    webrtcIceUrls: loadIceUrls(),
  };
}
