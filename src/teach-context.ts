import fs from "node:fs/promises";
import path from "node:path";

import { formatSemanticMemoryForPrompt, loadSemanticMemory, distillTeachSessionToSemanticMemory } from "./semantic-memory.js";
import { loadTeachSession } from "./teach-store.js";

export async function loadTeachContext(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  const session = await loadTeachSession(filePath);
  if (session.memoryPath) {
    try {
      const memory = await loadSemanticMemory(session.memoryPath);
      return formatSemanticMemoryForPrompt(memory);
    } catch {
      // Fall back to deriving memory directly from the teach session.
    }
  }

  const memory = distillTeachSessionToSemanticMemory(session);
  const sessionPath = path.resolve(process.cwd(), filePath);
  const memoryPath = path.join(path.dirname(sessionPath), "memory.json");
  await fs.writeFile(memoryPath, JSON.stringify(memory, null, 2));
  session.memoryPath = path.relative(process.cwd(), memoryPath);
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
  return formatSemanticMemoryForPrompt(memory);
}
