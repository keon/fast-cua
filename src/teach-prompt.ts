interface BuildTeachPromptArgs {
  task?: string;
  recentEventContext?: string;
}

export function buildTeachPrompt({ task, recentEventContext }: BuildTeachPromptArgs): string {
  return [
    "You are observing a live macOS screen stream while the human demonstrates a workflow.",
    "Your job is to understand the UI, infer what the human is doing, and extract reusable context for later automation.",
    "Use both the live screen and the recent observed user input events to interpret the current workflow step.",
    "Return exactly one compact minified JSON object and nothing else.",
    "",
    ...(task?.trim()
      ? [
          "OPTIONAL DEMONSTRATION GOAL:",
          task.trim(),
          "",
        ]
      : []),
    ...(recentEventContext?.trim()
      ? [
          "RECENT OBSERVED USER INPUT EVENTS:",
          recentEventContext.trim(),
          "",
        ]
      : []),
    "WHAT TO CAPTURE:",
    "- A short summary of the current screen and workflow step.",
    "- The visible app, if clear.",
    "- The likely user goal for this step, if obvious.",
    "- Up to 3 important reusable UI components.",
    "- A notable visual change only if one is obvious.",
    "",
    "IMPORTANT COMPONENT RULES:",
    "- Prefer stable semantic components like sidebar, tab, button, input, toggle, list, panel, or toolbar.",
    "- Use names that help a future agent find the same component again.",
    "- Use relative location hints, not pixel coordinates.",
    "- Include state only when it matters.",
    "- Prefer a very short high-value list over exhaustive detail.",
    "",
    "OUTPUT RULES:",
    "- Keep fields short and concrete.",
    "- Omit optional fields unless useful.",
    "- Keep `notableChange` empty unless a visual change is actually apparent.",
    "- Set `confidence` based on visual certainty.",
    "- Do not output actions or coordinates.",
    "- Use short phrases, not sentences, for component names and location hints when possible.",
    "- Do not include markdown fences.",
    "- Keep the entire JSON under roughly 450 characters if possible.",
    "",
    "RESPONSE FORMAT:",
    "{",
    '  "summary": "short summary of the current step or screen",',
    '  "visibleApp": "app or surface name if clear",',
    '  "userGoalGuess": "likely user goal for this step if inferable",',
    '  "notableChange": "important visual change if one is obvious",',
    '  "importantComponents": [',
    "    {",
    '      "name": "stable component name",',
    '      "role": "button | tab | toggle | sidebar | input | list | panel | toolbar | etc",',
    '      "locationHint": "relative location such as left sidebar near top",',
    '      "state": "optional state such as selected or disabled"',
    "    }",
    "  ],",
    '  "confidence": "low" | "medium" | "high"',
    "}",
  ].join("\n");
}
