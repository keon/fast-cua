import crypto from "node:crypto";

import { MacOSNativeBridge } from "./macos-native.js";
import type { ActionAck, ComputerAction, ExecutorConfig } from "./types.js";

interface ExecuteActionInput {
  sessionId: string;
  description: string;
  action: ComputerAction;
}

export interface ActionExecutor {
  execute(input: ExecuteActionInput): Promise<ActionAck>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateExecutableAction(action: ComputerAction): string | null {
  const pointerTypes = new Set(["click", "double_click", "right_click", "move"]);
  if (pointerTypes.has(action.type) && (!isFiniteNumber(action.x) || !isFiniteNumber(action.y))) {
    return "Pointer actions require finite `x` and `y` coordinates.";
  }

  if (action.type === "drag") {
    if (
      !isFiniteNumber(action.x) ||
      !isFiniteNumber(action.y) ||
      !isFiniteNumber(action.endX) ||
      !isFiniteNumber(action.endY)
    ) {
      return "Drag actions require finite start and end coordinates.";
    }
  }

  if (action.type === "scroll") {
    if (!isFiniteNumber(action.deltaX) && !isFiniteNumber(action.deltaY)) {
      return "Scroll actions require `deltaX` or `deltaY`.";
    }
  }

  if (action.type === "type" && !action.text) {
    return "Type actions require `text`.";
  }

  if (action.type === "keypress" && !action.key) {
    return "Keypress actions require `key`.";
  }

  return null;
}

class MockActionExecutor implements ActionExecutor {
  async execute(input: ExecuteActionInput): Promise<ActionAck> {
    const validationError = validateExecutableAction(input.action);
    if (validationError) {
      return {
        accepted: false,
        message: validationError,
      };
    }

    return {
      accepted: true,
      actionId: crypto.randomUUID(),
      message: "Action accepted by mock executor. Replace with a real OS automation backend.",
    };
  }
}

class WebhookActionExecutor implements ActionExecutor {
  constructor(private readonly config: Extract<ExecutorConfig, { type: "webhook" }>) {}

  async execute(input: ExecuteActionInput): Promise<ActionAck> {
    const validationError = validateExecutableAction(input.action);
    if (validationError) {
      return {
        accepted: false,
        message: validationError,
      };
    }

    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(input),
    });

    const body = (await response.json().catch(() => ({}))) as Partial<ActionAck> & {
      message?: string;
    };

    if (!response.ok) {
      return {
        accepted: false,
        message: body.message ?? `Executor returned ${response.status}`,
      };
    }

    return {
      accepted: body.accepted ?? true,
      actionId: body.actionId,
      message: body.message ?? "Action accepted by webhook executor.",
    };
  }
}

class MacOSNativeActionExecutor implements ActionExecutor {
  private readonly bridge = new MacOSNativeBridge();

  async execute(input: ExecuteActionInput): Promise<ActionAck> {
    const validationError = validateExecutableAction(input.action);
    if (validationError) {
      return {
        accepted: false,
        message: validationError,
      };
    }

    return await this.bridge.execute(input.action);
  }
}

export function createActionExecutor(config: ExecutorConfig): ActionExecutor {
  if (config.type === "webhook") {
    return new WebhookActionExecutor(config);
  }

  if (config.type === "macos_native") {
    return new MacOSNativeActionExecutor();
  }

  return new MockActionExecutor();
}
