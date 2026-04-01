import fs from "node:fs/promises";
import path from "node:path";

import type {
  SemanticMemoryAppKnowledge,
  SemanticMemoryComponent,
  TeachEntry,
  TeachSemanticMemoryFile,
  TeachSessionFile,
} from "./types.js";

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function uniqueStrings(values: Iterable<string | undefined>, limit?: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
    if (limit !== undefined && output.length >= limit) {
      break;
    }
  }
  return output;
}

function confidenceFromEntries(entries: TeachEntry[]): "low" | "medium" | "high" {
  const counts = { low: 0, medium: 0, high: 0 };
  for (const entry of entries) {
    counts[entry.annotation.confidence] += 1;
  }
  if (counts.high >= counts.medium && counts.high >= counts.low) {
    return "high";
  }
  if (counts.medium >= counts.low) {
    return "medium";
  }
  return "low";
}

function distillComponents(entries: TeachEntry[]): {
  navigationConcepts: SemanticMemoryComponent[];
  importantComponents: SemanticMemoryComponent[];
} {
  const componentMap = new Map<string, SemanticMemoryComponent>();

  for (const entry of entries) {
    for (const component of entry.annotation.importantComponents) {
      const name = normalizeText(component.name);
      const role = normalizeText(component.role);
      const locationHint = normalizeText(component.locationHint);
      if (!name || !role || !locationHint) {
        continue;
      }

      const key = `${name}::${role}`;
      const existing = componentMap.get(key);
      if (existing) {
        existing.evidenceCount += 1;
        existing.observedStates = uniqueStrings([...(existing.observedStates ?? []), component.state]);
        continue;
      }

      componentMap.set(key, {
        name,
        role,
        locationHint,
        semanticMeaning: inferSemanticMeaning(name, role),
        observedStates: uniqueStrings([component.state]),
        evidenceCount: 1,
      });
    }
  }

  const components = [...componentMap.values()].sort((a, b) => b.evidenceCount - a.evidenceCount);
  const navigationConcepts = components
    .filter((component) => ["sidebar", "list item", "list", "tab", "navigation target"].includes(component.role))
    .slice(0, 6);
  const importantComponents = components.slice(0, 8);
  return { navigationConcepts, importantComponents };
}

function inferSemanticMeaning(name: string, role: string): string | undefined {
  const lowered = `${name} ${role}`.toLowerCase();
  if (lowered.includes("dark")) return "likely toggles or indicates dark mode";
  if (lowered.includes("appearance")) return "likely opens or controls appearance settings";
  if (lowered.includes("sidebar")) return "primary navigation surface";
  if (lowered.includes("tab")) return "switches visible settings section";
  return undefined;
}

function distillSuccessSignals(entries: TeachEntry[]): string[] {
  const directSignals = entries.flatMap((entry) => [entry.annotation.notableChange, entry.annotation.summary]);
  const signals = uniqueStrings(directSignals, 8).filter((value) => {
    const lowered = value.toLowerCase();
    return (
      lowered.includes("selected") ||
      lowered.includes("switche") ||
      lowered.includes("enabled") ||
      lowered.includes("dark mode") ||
      lowered.includes("dark theme")
    );
  });
  return signals.slice(0, 6);
}

function distillRecoveryHints(entries: TeachEntry[]): string[] {
  const hints = uniqueStrings(
    entries.flatMap((entry) => [entry.annotation.summary, entry.annotation.userGoalGuess]),
  ).filter((value) => {
    const lowered = value.toLowerCase();
    return (
      lowered.includes("sidebar") ||
      lowered.includes("navigate") ||
      lowered.includes("select") ||
      lowered.includes("open")
    );
  });
  return hints.slice(0, 5);
}

function distillGoals(entries: TeachEntry[], task?: string): { goal: string; evidenceCount: number }[] {
  const counts = new Map<string, number>();
  for (const value of [task, ...entries.map((entry) => entry.annotation.userGoalGuess)]) {
    const normalized = normalizeText(value);
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([goal, evidenceCount]) => ({ goal, evidenceCount }))
    .sort((a, b) => b.evidenceCount - a.evidenceCount)
    .slice(0, 4);
}

export function distillTeachSessionToSemanticMemory(session: TeachSessionFile): TeachSemanticMemoryFile {
  const appBuckets = new Map<string, TeachEntry[]>();
  for (const entry of session.entries) {
    const app = normalizeText(entry.annotation.visibleApp) ?? "Unknown App";
    const bucket = appBuckets.get(app) ?? [];
    bucket.push(entry);
    appBuckets.set(app, bucket);
  }

  const apps: SemanticMemoryAppKnowledge[] = [...appBuckets.entries()].map(([app, entries]) => {
    const { navigationConcepts, importantComponents } = distillComponents(entries);
    return {
      app,
      confidence: confidenceFromEntries(entries),
      goals: distillGoals(entries, session.task),
      navigationConcepts,
      importantComponents,
      successSignals: distillSuccessSignals(entries),
      recoveryHints: distillRecoveryHints(entries),
    };
  });

  return {
    version: 1,
    sourceSessionId: session.id,
    sourceSessionName: session.name,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    task: session.task,
    apps,
  };
}

export function formatSemanticMemoryForPrompt(memory: TeachSemanticMemoryFile): string {
  const sections: string[] = [
    `Learned memory from teach session: ${memory.sourceSessionName}`,
    ...(memory.task ? [`Demonstrated goal: ${memory.task}`] : []),
  ];

  for (const app of memory.apps.slice(0, 3)) {
    sections.push(`App: ${app.app} (confidence: ${app.confidence})`);
    if (app.goals.length > 0) {
      sections.push("Goals:");
      sections.push(...app.goals.slice(0, 3).map((goal) => `- ${goal.goal}`));
    }
    if (app.navigationConcepts.length > 0) {
      sections.push("Navigation concepts:");
      sections.push(
        ...app.navigationConcepts.slice(0, 4).map((component) => `- ${component.name}: ${component.role} @ ${component.locationHint}`),
      );
    }
    if (app.importantComponents.length > 0) {
      sections.push("Important components:");
      sections.push(
        ...app.importantComponents.slice(0, 6).map((component) => {
          const parts = [`- ${component.name}: ${component.role} @ ${component.locationHint}`];
          if (component.semanticMeaning) parts.push(` | meaning=${component.semanticMeaning}`);
          if (component.observedStates && component.observedStates.length > 0) parts.push(` | states=${component.observedStates.join(", ")}`);
          return parts.join("");
        }),
      );
    }
    if (app.successSignals.length > 0) {
      sections.push("Success signals:");
      sections.push(...app.successSignals.slice(0, 4).map((signal) => `- ${signal}`));
    }
    if (app.recoveryHints.length > 0) {
      sections.push("Recovery hints:");
      sections.push(...app.recoveryHints.slice(0, 4).map((hint) => `- ${hint}`));
    }
  }

  const text = sections.join("\n");
  return text.length <= 1800 ? text : text.slice(0, 1800);
}

export async function loadSemanticMemory(filePath: string): Promise<TeachSemanticMemoryFile> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  return JSON.parse(await fs.readFile(absolutePath, "utf8")) as TeachSemanticMemoryFile;
}
