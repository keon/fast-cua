import "./env.js";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import process from "node:process";

import { StreamClient } from "overshoot";

import { OvershootCliAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { loadTeachContext } from "./teach-context.js";
import { OvershootTeachRecorder } from "./teach-recorder.js";
import type { CreateSessionInput, CreateTeachInput, ExecutorConfig } from "./types.js";
import { MacOSScreenCaptureBridge } from "./macos-capture.js";

type ParsedArgs = {
  _: string[];
  [key: string]: string | string[] | undefined;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }

    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function getStringArg(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed[key];
  return typeof value === "string" ? value : undefined;
}

function requireStringArg(parsed: ParsedArgs, key: string, fallback?: string): string {
  const value = getStringArg(parsed, key) ?? fallback;
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function getNumberArg(parsed: ParsedArgs, key: string, fallback?: number): number | undefined {
  const raw = getStringArg(parsed, key);
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} must be a valid number.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`fast-cua CLI

Usage:
  pnpm dev -- models
  pnpm dev -- run --task "..."
  pnpm dev -- teach [--name "..."]
  pnpm dev -- capture-once [--output screenshot.png]
  pnpm dev -- list-displays

Commands:
  models                    List available Overshoot models
  run                       Start one computer-use session and keep running until stopped
  teach                     Record a demonstration session and save replayable teach context
  capture-once              Save one local screenshot to disk
  list-displays             List available macOS displays and their ids

run options:
  --task                    Required task description
  --strategy                Optional extra instructions for how to achieve the task
  --teach-file              Optional teach session manifest to load as prior context
  --model                   Optional model override
  --interval                Optional frame interval in seconds, default from .env.local
  --display-id              Optional macOS display id for screenshot capture
  --backend                 Optional backend: overshoot | gemini
  --max-output-tokens       Optional max output tokens
  --executor                Optional executor: macos_native | mock | webhook
  --action-webhook-url      Required when --executor webhook
  --task-file               Load task text from a file
  --strategy-file           Load strategy text from a file

teach options:
  --name                    Optional teach session name
  --task                    Optional demonstration goal label
  --model                   Optional model override
  --interval                Optional frame interval in seconds, default from .env.local
  --display-id              Optional macOS display id for screenshot capture
  --backend                 Optional backend: overshoot | gemini
  --max-output-tokens       Optional max output tokens
  --help                    Show this help
`);
}

async function maybeReadFile(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  return (await fs.readFile(filePath, "utf8")).trim();
}

function resolveExecutor(parsed: ParsedArgs, fallback: ExecutorConfig): ExecutorConfig {
  const executorType = getStringArg(parsed, "executor");
  if (!executorType) {
    return fallback;
  }

  if (executorType === "mock") {
    return { type: "mock" };
  }

  if (executorType === "macos_native") {
    return { type: "macos_native" };
  }

  if (executorType === "webhook") {
    const url = requireStringArg(parsed, "action-webhook-url", process.env.ACTION_WEBHOOK_URL);
    return {
      type: "webhook",
      url,
    };
  }

  throw new Error(`Unsupported executor: ${executorType}`);
}

async function buildRunInput(parsed: ParsedArgs): Promise<CreateSessionInput> {
  const config = loadConfig();
  const taskFromFile = await maybeReadFile(getStringArg(parsed, "task-file"));
  const strategyFromFile = await maybeReadFile(getStringArg(parsed, "strategy-file"));

  return {
    task: requireStringArg(parsed, "task", taskFromFile),
    strategy: getStringArg(parsed, "strategy") ?? strategyFromFile,
    teachContext: await loadTeachContext(getStringArg(parsed, "teach-file")),
    model: getStringArg(parsed, "model") ?? config.defaultModel,
    intervalSeconds: getNumberArg(parsed, "interval", config.defaultIntervalSeconds) ?? config.defaultIntervalSeconds,
    displayId: getNumberArg(parsed, "display-id"),
    backend: (getStringArg(parsed, "backend") as "overshoot" | "gemini" | undefined) ?? undefined,
    maxOutputTokens: getNumberArg(parsed, "max-output-tokens"),
    executor: resolveExecutor(parsed, config.defaultExecutor),
  };
}

async function buildTeachInput(parsed: ParsedArgs): Promise<CreateTeachInput> {
  const config = loadConfig();
  const taskFromFile = await maybeReadFile(getStringArg(parsed, "task-file"));
  const teachDefaultIntervalSeconds = Math.max(config.defaultIntervalSeconds, 2);
  const intervalSeconds = getNumberArg(parsed, "interval", teachDefaultIntervalSeconds) ?? teachDefaultIntervalSeconds;
  const requestedMaxOutputTokens = getNumberArg(parsed, "max-output-tokens");
  const maxAllowedOutputTokens = Math.max(32, Math.floor(intervalSeconds * 256));

  if (
    requestedMaxOutputTokens !== undefined &&
    requestedMaxOutputTokens > maxAllowedOutputTokens
  ) {
    throw new Error(
      `--max-output-tokens ${requestedMaxOutputTokens} is too high for --interval ${intervalSeconds}. ` +
        `Overshoot requires max_output_tokens / interval_seconds <= 256, so use at most ${maxAllowedOutputTokens}.`,
    );
  }

  return {
    name: getStringArg(parsed, "name") ?? `teach-${new Date().toISOString()}`,
    task: getStringArg(parsed, "task") ?? taskFromFile,
    model: getStringArg(parsed, "model") ?? config.defaultModel,
    intervalSeconds,
    displayId: getNumberArg(parsed, "display-id"),
    backend: (getStringArg(parsed, "backend") as "overshoot" | "gemini" | undefined) ?? undefined,
    maxOutputTokens: requestedMaxOutputTokens ?? Math.min(512, maxAllowedOutputTokens),
  };
}

async function runModels(): Promise<void> {
  const config = loadConfig();
  const client = new StreamClient({
    apiKey: config.overshootApiKey,
    baseUrl: config.overshootApiUrl,
  });
  const models = await client.getModels();
  console.log(JSON.stringify({ models }, null, 2));
}

async function runSession(parsed: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const input = await buildRunInput(parsed);
  const session = new OvershootCliAgent(crypto.randomUUID(), config, input);

  await session.start();
  const snapshot = session.getSnapshot();
  console.log(JSON.stringify({ sessionId: snapshot.id, status: snapshot.status }, null, 2));
  console.log("Overshoot CLI agent is running. Press Ctrl+C to stop.");

  let shutdownRequested = false;
  const shutdown = async (signal: string) => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    console.log(`Received ${signal}. Stopping session...`);
    await session.stop();
  };

  const onSigInt = () => {
    void shutdown("SIGINT");
  };

  const onSigTerm = () => {
    void shutdown("SIGTERM");
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  const monitorPromise = new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      const current = session.getSnapshot();
      if (current.status === "error") {
        clearInterval(interval);
        reject(new Error(current.latestError ?? "Session ended with an unknown error."));
        return;
      }

      if (current.status === "stopped") {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });

  try {
    await monitorPromise;
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }

  process.exit(0);
}

async function runTeachSession(parsed: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const input = await buildTeachInput(parsed);
  const recorder = new OvershootTeachRecorder(crypto.randomUUID(), config, input);

  await recorder.start();
  const snapshot = recorder.getSnapshot();
  console.log(JSON.stringify({ sessionId: snapshot.id, status: snapshot.status, manifestPath: snapshot.manifestPath }, null, 2));
  console.log("Teach recorder is running. Demonstrate the workflow and press Ctrl+C to stop.");

  let shutdownRequested = false;
  const shutdown = async (signal: string) => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    console.log(`Received ${signal}. Stopping teach session...`);
    await recorder.stop();
  };

  const onSigInt = () => {
    void shutdown("SIGINT");
  };

  const onSigTerm = () => {
    void shutdown("SIGTERM");
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  const monitorPromise = new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      const current = recorder.getSnapshot();
      if (current.status === "error") {
        clearInterval(interval);
        reject(new Error(current.latestError ?? "Teach session ended with an unknown error."));
        return;
      }

      if (current.status === "stopped") {
        clearInterval(interval);
        resolve();
      }
    }, 500);
  });

  try {
    await monitorPromise;
    console.log(`Teach session saved to ${recorder.getSnapshot().manifestPath}`);
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  }

  process.exit(0);
}

async function captureOnce(parsed: ParsedArgs): Promise<void> {
  const capturer = new MacOSScreenCaptureBridge();
  const output = getStringArg(parsed, "output") ?? `screenshot-${Date.now()}.png`;
  const displayId = getNumberArg(parsed, "display-id");
  const capture = await capturer.capture(displayId);
  await fs.copyFile(capture.path, output);
  await capturer.cleanup(capture.path);
  console.log(`Saved screenshot to ${output}`);
}

async function listDisplays(): Promise<void> {
  const capturer = new MacOSScreenCaptureBridge();
  const displays = await capturer.listDisplays();
  console.log(JSON.stringify({ displays }, null, 2));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed._[0];

  if (!command || command === "help" || getStringArg(parsed, "help") === "true") {
    printHelp();
    return;
  }

  if (command === "models") {
    await runModels();
    return;
  }

  if (command === "run") {
    await runSession(parsed);
    return;
  }

  if (command === "teach") {
    await runTeachSession(parsed);
    return;
  }

  if (command === "capture-once") {
    await captureOnce(parsed);
    return;
  }

  if (command === "list-displays") {
    await listDisplays();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
