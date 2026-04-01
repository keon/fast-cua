export type MouseActionType = "click" | "double_click" | "right_click" | "move";
export type KeyboardActionType = "type" | "keypress";
export type ScrollActionType = "scroll";
export type DragActionType = "drag";

export type ActionType =
  | MouseActionType
  | KeyboardActionType
  | ScrollActionType
  | DragActionType;

export interface ComputerAction {
  type: ActionType;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  key?: string;
  button?: "left" | "right" | "middle";
}

export type ComputerUseToolName =
  | "wait"
  | "left_click"
  | "right_click"
  | "middle_click"
  | "double_click"
  | "mouse_move"
  | "left_click_drag"
  | "scroll"
  | "type"
  | "key"
  | "switch_display";

export interface ComputerUseToolInput {
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  text?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  duration?: number;
  display_id?: number | "auto";
}

export interface AgentDecision {
  tool: ComputerUseToolName;
  input: ComputerUseToolInput;
  description: string;
}

export interface ActionRecord {
  timestamp: string;
  status: "accepted" | "rejected";
  description: string;
  tool: ComputerUseToolName;
  input: ComputerUseToolInput;
  responseMessage: string;
}

export interface ActionAck {
  accepted: boolean;
  message: string;
  actionId?: string;
}

export interface LogEntry {
  level: "info" | "error";
  message: string;
  timestamp: string;
}

export interface WebhookExecutorConfig {
  type: "webhook";
  url: string;
  headers?: Record<string, string>;
}

export interface MacOSNativeExecutorConfig {
  type: "macos_native";
}

export interface MockExecutorConfig {
  type: "mock";
}

export type ExecutorConfig =
  | MockExecutorConfig
  | WebhookExecutorConfig
  | MacOSNativeExecutorConfig;

export interface CreateSessionInput {
  task: string;
  strategy?: string;
  teachContext?: string;
  model: string;
  intervalSeconds: number;
  displayId?: number;
  backend?: "overshoot" | "gemini";
  maxOutputTokens?: number;
  executor?: ExecutorConfig;
}

export interface CreateTeachInput {
  name: string;
  task?: string;
  model: string;
  intervalSeconds: number;
  displayId?: number;
  backend?: "overshoot" | "gemini";
  maxOutputTokens?: number;
}

export interface ComputerUseScreenshotDims {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  displayId?: number;
  originX?: number;
  originY?: number;
}

export interface ComputerUseDisplayInfo {
  id: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  isMain: boolean;
}

export interface ComputerUseState {
  selectedDisplayId?: number;
  displayPinnedByModel: boolean;
  displayResolvedForApps?: string;
  lastScreenshotDims?: ComputerUseScreenshotDims;
  availableDisplays: ComputerUseDisplayInfo[];
}

export type SessionStatus = "starting" | "running" | "stopping" | "stopped" | "error";

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  streamId: string | null;
  task: string;
  strategy?: string;
  teachContext?: string;
  model: string;
  intervalSeconds: number;
  latestModelOutput: string | null;
  latestError: string | null;
  prompt: string;
  history: ActionRecord[];
  logs: LogEntry[];
  computerUseState: ComputerUseState;
}

export interface TeachComponentRecord {
  name: string;
  role: string;
  locationHint: string;
  state?: string;
}

export interface TeachAnnotation {
  summary: string;
  visibleApp?: string;
  userGoalGuess?: string;
  notableChange?: string;
  importantComponents: TeachComponentRecord[];
  confidence: "low" | "medium" | "high";
}

export interface TeachUserEvent {
  timestamp: string;
  type:
    | "left_mouse_down"
    | "left_mouse_up"
    | "right_mouse_down"
    | "right_mouse_up"
    | "middle_mouse_down"
    | "middle_mouse_up"
    | "scroll"
    | "key_down";
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  modifiers?: string[];
  frontmostApp?: string;
  frontmostBundleId?: string;
}

export interface TeachEntry {
  timestamp: string;
  displayId?: number;
  screenshotPath?: string;
  screenshotDims?: ComputerUseScreenshotDims;
  annotation: TeachAnnotation;
  userEvents: TeachUserEvent[];
}

export interface TeachSessionFile {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  task?: string;
  summary?: string;
  rawEventsPath?: string;
  memoryPath?: string;
  entries: TeachEntry[];
}

export interface SemanticMemoryComponent {
  name: string;
  role: string;
  locationHint: string;
  semanticMeaning?: string;
  observedStates?: string[];
  evidenceCount: number;
}

export interface SemanticMemoryGoal {
  goal: string;
  evidenceCount: number;
}

export interface SemanticMemoryAppKnowledge {
  app: string;
  confidence: "low" | "medium" | "high";
  goals: SemanticMemoryGoal[];
  navigationConcepts: SemanticMemoryComponent[];
  importantComponents: SemanticMemoryComponent[];
  successSignals: string[];
  recoveryHints: string[];
}

export interface TeachSemanticMemoryFile {
  version: 1;
  sourceSessionId: string;
  sourceSessionName: string;
  createdAt: string;
  updatedAt: string;
  task?: string;
  apps: SemanticMemoryAppKnowledge[];
}

export interface AppConfig {
  defaultModel: string;
  defaultIntervalSeconds: number;
  defaultExecutor: ExecutorConfig;
  overshootApiKey: string;
  overshootApiUrl?: string;
  captureFps: number;
  webrtcIceUrls: string[];
}
