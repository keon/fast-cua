import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ActionAck, ComputerAction } from "./types.js";

const sourcePath = path.resolve(process.cwd(), "native", "macos-input.swift");
const binaryDirectory = path.resolve(process.cwd(), ".native-bin");
const binaryPath = path.join(binaryDirectory, "macos-input");

async function statOrNull(filePath: string) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function needsRebuild(): Promise<boolean> {
  const [sourceStat, binaryStat] = await Promise.all([statOrNull(sourcePath), statOrNull(binaryPath)]);

  if (!sourceStat) {
    throw new Error(`Native source not found at ${sourcePath}`);
  }

  if (!binaryStat) {
    return true;
  }

  return sourceStat.mtimeMs > binaryStat.mtimeMs;
}

async function runProcess(
  command: string,
  args: string[],
  stdinPayload?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    if (stdinPayload !== undefined) {
      child.stdin.write(stdinPayload);
    }

    child.stdin.end();
  });
}

export class MacOSNativeBridge {
  private buildPromise: Promise<void> | null = null;

  async ensureBuilt(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("The macOS native executor only works on macOS.");
    }

    if (!this.buildPromise) {
      this.buildPromise = this.buildIfNeeded();
    }

    await this.buildPromise;
  }

  async execute(action: ComputerAction): Promise<ActionAck> {
    await this.ensureBuilt();

    const result = await runProcess(binaryPath, [], JSON.stringify(action));
    if (result.code !== 0) {
      return {
        accepted: false,
        message: result.stderr.trim() || result.stdout.trim() || `Native executor exited with ${result.code}`,
      };
    }

    try {
      const parsed = JSON.parse(result.stdout) as ActionAck;
      return {
        accepted: parsed.accepted,
        message: parsed.message,
        actionId: parsed.actionId,
      };
    } catch {
      return {
        accepted: false,
        message: `Native executor returned invalid JSON: ${result.stdout.trim()}`,
      };
    }
  }

  private async buildIfNeeded(): Promise<void> {
    const rebuild = await needsRebuild();
    if (!rebuild) {
      return;
    }

    await fs.mkdir(binaryDirectory, { recursive: true });

    const result = await runProcess("swiftc", [sourcePath, "-O", "-o", binaryPath]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to compile macOS native helper.");
    }
  }
}
