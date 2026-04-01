import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import type { TeachUserEvent } from "./types.js";

const sourcePath = path.resolve(process.cwd(), "native", "macos-observer.swift");
const binaryDirectory = path.resolve(process.cwd(), ".native-bin");
const binaryPath = path.join(binaryDirectory, "macos-observer");

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
    throw new Error(`Native observer source not found at ${sourcePath}`);
  }

  if (!binaryStat) {
    return true;
  }

  return sourceStat.mtimeMs > binaryStat.mtimeMs;
}

async function runProcess(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  });
}

export class MacOSInputObserver {
  private buildPromise: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private reader: readline.Interface | null = null;

  async ensureBuilt(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("The macOS input observer only works on macOS.");
    }

    if (!this.buildPromise) {
      this.buildPromise = this.buildIfNeeded();
    }

    await this.buildPromise;
  }

  async start(onEvent: (event: TeachUserEvent) => void): Promise<void> {
    await this.ensureBuilt();

    if (this.child) {
      throw new Error("macOS input observer is already running.");
    }

    const child = spawn(binaryPath, [], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    if (!child.stdout || !child.stderr) {
      throw new Error("macOS input observer did not expose stdout/stderr pipes.");
    }

    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        onEvent(JSON.parse(line) as TeachUserEvent);
      } catch {
        // Ignore malformed observer lines.
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // stderr is reserved for debugging / permission failure text.
    });

    child.on("close", () => {
      this.reader?.close();
      this.reader = null;
      this.child = null;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    await new Promise<void>((resolve) => {
      const handleClose = () => resolve();
      child.once("close", handleClose);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child) {
          this.child.kill("SIGKILL");
        }
      }, 500);
    });
  }

  private async buildIfNeeded(): Promise<void> {
    const rebuild = await needsRebuild();
    if (!rebuild) {
      return;
    }

    await fs.mkdir(binaryDirectory, { recursive: true });
    const result = await runProcess("swiftc", [sourcePath, "-O", "-o", binaryPath]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to compile macOS observer helper.");
    }
  }
}
