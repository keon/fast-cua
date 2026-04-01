import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const sourcePath = path.resolve(process.cwd(), "native", "macos-capture.swift");
const binaryDirectory = path.resolve(process.cwd(), ".native-bin");
const binaryPath = path.join(binaryDirectory, "macos-capture");

export interface ScreenCaptureResult {
  path: string;
  base64Png: string;
  display: {
    id: number;
    width: number;
    height: number;
    originX: number;
    originY: number;
    isMain: boolean;
  };
}

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
    throw new Error(`Native capture source not found at ${sourcePath}`);
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

export class MacOSScreenCaptureBridge {
  private buildPromise: Promise<void> | null = null;

  async ensureBuilt(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("Local screen capture is only supported on macOS.");
    }

    if (!this.buildPromise) {
      this.buildPromise = this.buildIfNeeded();
    }

    await this.buildPromise;
  }

  async capture(displayId?: number): Promise<ScreenCaptureResult> {
    await this.ensureBuilt();

    const args = displayId !== undefined ? ["--display-id", String(displayId)] : [];
    const result = await runProcess(binaryPath, args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Screen capture failed with ${result.code}`);
    }

    const parsed = JSON.parse(result.stdout) as ScreenCaptureResult;
    return parsed;
  }

  async listDisplays(): Promise<Array<{ id: number; width: number; height: number; originX: number; originY: number; isMain: boolean }>> {
    await this.ensureBuilt();
    const result = await runProcess(binaryPath, ["--list-displays"]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Display listing failed with ${result.code}`);
    }
    return JSON.parse(result.stdout) as Array<{ id: number; width: number; height: number; originX: number; originY: number; isMain: boolean }>;
  }

  async cleanup(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true });
  }

  private async buildIfNeeded(): Promise<void> {
    const rebuild = await needsRebuild();
    if (!rebuild) {
      return;
    }

    await fs.mkdir(binaryDirectory, { recursive: true });
    const result = await runProcess("swiftc", [sourcePath, "-O", "-o", binaryPath]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to compile macOS capture helper.");
    }
  }
}
