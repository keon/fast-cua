import fs from "node:fs/promises";
import path from "node:path";

import { distillTeachSessionToSemanticMemory } from "./semantic-memory.js";
import type {
  ComputerUseDisplayInfo,
  ComputerUseScreenshotDims,
  TeachAnnotation,
  TeachEntry,
  TeachSessionFile,
  TeachUserEvent,
} from "./types.js";

interface CreateTeachSessionArgs {
  id: string;
  name: string;
  task?: string;
}

export class TeachSessionStore {
  private readonly rootDir: string;
  private readonly framesDir: string;
  private readonly rawEventsPath: string;
  private readonly memoryPath: string;
  private readonly manifestPath: string;
  private session: TeachSessionFile;
  private availableDisplays: ComputerUseDisplayInfo[] = [];
  private lastScreenshotDims: ComputerUseScreenshotDims | undefined;
  private rawEventWriteChain: Promise<void> = Promise.resolve();

  private constructor(rootDir: string, session: TeachSessionFile) {
    this.rootDir = rootDir;
    this.framesDir = path.join(rootDir, "frames");
    this.rawEventsPath = path.join(rootDir, "events.jsonl");
    this.memoryPath = path.join(rootDir, "memory.json");
    this.manifestPath = path.join(rootDir, "session.json");
    this.session = session;
  }

  static async create(args: CreateTeachSessionArgs): Promise<TeachSessionStore> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "teach-session";
    const rootDir = path.resolve(process.cwd(), ".teach", `${timestamp}-${slug}`);
    const session: TeachSessionFile = {
      version: 1,
      id: args.id,
      name: args.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      task: args.task,
      summary: undefined,
      rawEventsPath: undefined,
      entries: [],
    };

    const store = new TeachSessionStore(rootDir, session);
    await fs.mkdir(store.framesDir, { recursive: true });
    session.rawEventsPath = path.relative(process.cwd(), store.rawEventsPath);
    session.memoryPath = path.relative(process.cwd(), store.memoryPath);
    await store.flush();
    return store;
  }

  getManifestPath(): string {
    return this.manifestPath;
  }

  setAvailableDisplays(displays: readonly ComputerUseDisplayInfo[]): void {
    this.availableDisplays = displays.map((display) => ({ ...display }));
  }

  setLastScreenshotDims(dims: ComputerUseScreenshotDims): void {
    this.lastScreenshotDims = { ...dims };
  }

  async append(annotation: TeachAnnotation, userEvents: TeachUserEvent[], pngBuffer?: Buffer): Promise<void> {
    const entry: TeachEntry = {
      timestamp: new Date().toISOString(),
      displayId: this.lastScreenshotDims?.displayId,
      screenshotPath: pngBuffer ? await this.writeFrame(pngBuffer) : undefined,
      screenshotDims: this.lastScreenshotDims ? { ...this.lastScreenshotDims } : undefined,
      annotation,
      userEvents: userEvents.map((event) => ({ ...event, modifiers: event.modifiers ? [...event.modifiers] : undefined })),
    };
    this.session.entries.push(entry);
    this.session.updatedAt = new Date().toISOString();
    this.session.summary = annotation.summary;
    await this.flush();
  }

  async appendRawEvent(event: TeachUserEvent): Promise<void> {
    this.rawEventWriteChain = this.rawEventWriteChain.then(() =>
      fs.appendFile(this.rawEventsPath, `${JSON.stringify(event)}\n`),
    );
    await this.rawEventWriteChain;
  }

  private async writeFrame(pngBuffer: Buffer): Promise<string> {
    const filename = `${this.session.entries.length.toString().padStart(4, "0")}-${Date.now()}.png`;
    const absolutePath = path.join(this.framesDir, filename);
    await fs.writeFile(absolutePath, pngBuffer);
    return path.relative(process.cwd(), absolutePath);
  }

  private async flush(): Promise<void> {
    const memory = distillTeachSessionToSemanticMemory(this.session);
    await fs.writeFile(this.memoryPath, JSON.stringify(memory, null, 2));
    await fs.writeFile(this.manifestPath, JSON.stringify(this.session, null, 2));
  }
}

export async function loadTeachSession(filePath: string): Promise<TeachSessionFile> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  return JSON.parse(await fs.readFile(absolutePath, "utf8")) as TeachSessionFile;
}

export function summarizeTeachSession(session: TeachSessionFile): string {
  const recentEntries = session.entries.slice(-8);
  const componentMap = new Map<string, string>();

  for (const entry of session.entries) {
    for (const component of entry.annotation.importantComponents) {
      const key = component.name.trim();
      if (!key || componentMap.has(key)) {
        continue;
      }

      const summary = `${component.role} at ${component.locationHint}${component.state ? ` (${component.state})` : ""}`;
      componentMap.set(key, summary);
    }
  }

  const componentLines = [...componentMap.entries()]
    .slice(0, 8)
    .map(([name, summary]) => `- ${name}: ${summary}`);

  const recentLines = recentEntries.slice(-4).map((entry, index) => {
    const eventSummary = summarizeUserEvents(entry.userEvents);
    return `${index + 1}. ${entry.annotation.summary}${entry.annotation.notableChange ? ` | change=${entry.annotation.notableChange}` : ""}${eventSummary ? ` | events=${eventSummary}` : ""}`;
  });

  const text = [
    `Teach session: ${session.name}`,
    ...(session.task ? [`Demonstration goal: ${session.task}`] : []),
    ...(session.summary ? [`Latest summary: ${session.summary}`] : []),
    componentLines.length > 0 ? "Known components:" : "Known components: none yet",
    ...componentLines,
    recentLines.length > 0 ? "Recent demonstrated steps:" : "Recent demonstrated steps: none yet",
    ...recentLines,
  ].join("\n");

  return text.length <= 1200 ? text : compactTeachSummary(session);
}

function compactTeachSummary(session: TeachSessionFile): string {
  const components = new Map<string, string>();
  for (const entry of session.entries) {
    for (const component of entry.annotation.importantComponents) {
      if (components.size >= 6) {
        break;
      }
      const key = component.name.trim();
      if (!key || components.has(key)) {
        continue;
      }
      components.set(
        key,
        `${component.role} @ ${component.locationHint}${component.state ? ` (${component.state})` : ""}`,
      );
    }
    if (components.size >= 6) {
      break;
    }
  }

  const recent = session.entries.slice(-3).map((entry, index) => `${index + 1}. ${entry.annotation.summary}`);
  return [
    `Teach: ${session.name}`,
    ...(session.task ? [`Goal: ${session.task}`] : []),
    ...(session.summary ? [`Latest: ${session.summary}`] : []),
    components.size > 0 ? "Components:" : "Components: none yet",
    ...[...components.entries()].map(([name, summary]) => `- ${name}: ${summary}`),
    recent.length > 0 ? "Recent:" : "Recent: none yet",
    ...recent,
  ].join("\n");
}

function summarizeUserEvents(events: TeachUserEvent[]): string {
  if (events.length === 0) {
    return "";
  }

  return events
    .slice(-6)
    .map((event) => {
      switch (event.type) {
        case "key_down":
          return event.key ? `key:${event.key}` : "key";
        case "scroll":
          return `scroll(${event.deltaX ?? 0},${event.deltaY ?? 0})`;
        default:
          return event.type;
      }
    })
    .join(", ");
}
