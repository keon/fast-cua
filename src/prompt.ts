import type { ActionRecord, ComputerUseState } from "./types.js";

interface BuildPromptArgs {
  task: string;
  strategy?: string;
  teachContext?: string;
  history: ActionRecord[];
  computerUseState: ComputerUseState;
  consecutiveWaits?: number;
  recentWaitDescriptions?: string[];
  verificationNote?: string;
}

function formatHistory(history: ActionRecord[]): string {
  if (history.length === 0) {
    return "No computer-use actions have been attempted yet.";
  }

  return history
    .map((record, index) => {
      const input = JSON.stringify(record.input);
      return `${index + 1}. [${record.status}] ${record.description} | tool=${record.tool} | input=${input} | note=${record.responseMessage}`;
    })
    .join("\n");
}

function formatDisplays(state: ComputerUseState): string {
  if (state.availableDisplays.length === 0) {
    return "No display information has been captured yet.";
  }

  return state.availableDisplays
    .map((display) => {
      const selected = state.selectedDisplayId === display.id ? " selected" : "";
      const main = display.isMain ? " main" : "";
      return `- display_id=${display.id}${main}${selected} size=${display.width}x${display.height} origin=(${display.originX}, ${display.originY})`;
    })
    .join("\n");
}

function formatScreenshotState(state: ComputerUseState): string {
  const dims = state.lastScreenshotDims;
  if (!dims) {
    return "No screenshot metadata is available yet.";
  }

  return [
    `- display_id=${dims.displayId ?? state.selectedDisplayId ?? "unknown"}`,
    `- image_size=${dims.width}x${dims.height}`,
    `- display_size=${dims.displayWidth}x${dims.displayHeight}`,
    `- origin=(${dims.originX ?? 0}, ${dims.originY ?? 0})`,
  ].join("\n");
}

export function buildAgentPrompt({
  task,
  strategy,
  teachContext,
  history,
  computerUseState,
  consecutiveWaits = 0,
  recentWaitDescriptions = [],
  verificationNote,
}: BuildPromptArgs): string {
  const trimmedStrategy = strategy?.trim();

  return [
    "You are controlling a computer from a live macOS screen stream.",
    "The latest frame already acts like the current screenshot, so do not ask for another screenshot tool.",
    "Return exactly one JSON object and nothing else.",
    "",
    "TASK TO BE DONE:",
    task.trim(),
    "",
    ...(trimmedStrategy
      ? [
          "HOW TO ACHIEVE THE TASK:",
          trimmedStrategy,
          "",
        ]
      : []),
    ...(teachContext?.trim()
      ? [
          "LEARNED UI MEMORY:",
          teachContext.trim(),
          "",
        ]
      : []),
    "COMPUTER USE STATE:",
    `- selected_display_id=${computerUseState.selectedDisplayId ?? "unknown"}`,
    `- display_pinned_by_model=${computerUseState.displayPinnedByModel}`,
    computerUseState.displayResolvedForApps
      ? `- display_resolved_for_apps=${computerUseState.displayResolvedForApps}`
      : "- display_resolved_for_apps=none",
    "",
    "AVAILABLE DISPLAYS:",
    formatDisplays(computerUseState),
    "",
    "LATEST SCREENSHOT METADATA:",
    formatScreenshotState(computerUseState),
    "",
    "COMPUTER USE ACTIONS ATTEMPTED SO FAR:",
    formatHistory(history),
    "",
    "CURRENT WAIT STREAK:",
    String(consecutiveWaits),
    "",
    "VERIFICATION STATUS:",
    verificationNote ?? "No special verification note.",
    "",
    "RECENT WAIT OBSERVATIONS:",
    recentWaitDescriptions.length > 0
      ? recentWaitDescriptions.map((value, index) => `${index + 1}. ${value}`).join("\n")
      : "No recent wait observations.",
    "",
    "AVAILABLE COMPUTER USE TOOLS:",
    '- `wait` with `{ "duration": number }` when you need to observe the UI or let a transition settle.',
    '- `left_click`, `right_click`, `middle_click`, `double_click`, and `mouse_move` with `{ "coordinate": [x, y] }`.',
    '- `left_click_drag` with `{ "start_coordinate": [x, y], "coordinate": [x, y] }`.',
    '- `scroll` with `{ "direction": "up" | "down" | "left" | "right", "amount": number, "coordinate": [x, y] }`.',
    '- `type` with `{ "text": string }`.',
    '- `key` with `{ "text": string }` for shortcuts like `cmd+l`, `enter`, or `shift+tab`.',
    '- `switch_display` with `{ "display_id": number | "auto" }` when the wrong display is being shown.',
    "",
    "DECISION RULES:",
    "- Take at most one computer-use tool action per response.",
    "- Prefer `wait` when the UI is loading, animating, uncertain, or still reacting to the previous action.",
    "- Use coordinates from the current frame, not guessed absolute desktop coordinates.",
    "- For clicks, aim near the center of the target control instead of the edge or label boundary.",
    "- After clicking a toggle, tab, theme tile, or sidebar item, wait and verify the visual result before clicking it again.",
    "- Do not repeat the exact same click over and over if the UI already appears to have registered it.",
    "- If a row, tab, or segmented control already looks selected or highlighted, do not click it again.",
    "- If the task is already complete, use `wait` and set the description to `Task complete`.",
    "- If the wrong display is visible and the target app is likely elsewhere, use `switch_display` instead of waiting forever.",
    "- If the wait streak is 3 or higher, only wait again when you can clearly see an ongoing transition, loading state, or pending visual confirmation.",
    "- Prefer minimal precise actions instead of long speculative sequences.",
    "- Do not explain your reasoning.",
    "",
    "HOW TO FORMAT THE RESPONSE:",
    "{",
    '  "tool": "wait" | "left_click" | "right_click" | "middle_click" | "double_click" | "mouse_move" | "left_click_drag" | "scroll" | "type" | "key" | "switch_display",',
    '  "input": {',
    '    "coordinate": [number, number],',
    '    "start_coordinate": [number, number],',
    '    "text": string,',
    '    "direction": "up" | "down" | "left" | "right",',
    '    "amount": number,',
    '    "duration": number,',
    '    "display_id": number | "auto"',
    "  },",
    '  "description": "short past-tense description of what happened or should happen"',
    "}",
  ].join("\n");
}
