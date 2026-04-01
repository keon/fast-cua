import wrtc from "@roamhq/wrtc";
import { PNG } from "pngjs";
import { StreamClient, type StreamInferenceResult } from "overshoot";

import { ComputerUseStateStore } from "./cua-state.js";
import { createActionExecutor } from "./executor.js";
import { MacOSScreenCaptureBridge } from "./macos-capture.js";
import { buildAgentPrompt } from "./prompt.js";
import { agentDecisionJsonSchema, agentDecisionSchema } from "./schema.js";
import type {
  ActionAck,
  ActionRecord,
  AgentDecision,
  AppConfig,
  ComputerAction,
  ComputerUseToolName,
  CreateSessionInput,
  LogEntry,
  SessionSnapshot,
  SessionStatus,
} from "./types.js";

const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCVideoSource, rgbaToI420 } = nonstandard;

const LOG_CAP = 200;
const DEDUPE_WINDOW_MS = 1200;
const ICE_GATHER_TIMEOUT_MS = 2500;
const POINTER_DEDUPE_RADIUS_PX = 36;
const REPEATED_POINTER_ACTION_COOLDOWN_MS = 5000;
const REPEATED_POINTER_ACTION_THRESHOLD = 2;
const WAIT_STREAK_RECOVERY_THRESHOLD = 3;
const WAIT_PROMPT_REFRESH_INTERVAL = 2;
const RECENT_WAIT_MEMORY = 4;
const COMPLETION_VERIFICATION_FRAMES = 2;
const COMPLETION_VERIFICATION_MIN_AGE_MS = 1200;

interface FrameGeometry {
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  originX: number;
  originY: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForIceGatheringComplete(peerConnection: RTCPeerConnection): Promise<void> {
  if (peerConnection.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      peerConnection.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, ICE_GATHER_TIMEOUT_MS);

    function onChange() {
      if (peerConnection.iceGatheringState === "complete") {
        clearTimeout(timeout);
        peerConnection.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }

    peerConnection.addEventListener("icegatheringstatechange", onChange);
  });
}

function normalizeIceServers(urls: string[]): RTCIceServer[] {
  if (urls.length === 0) {
    return [];
  }

  return [{ urls }];
}

function mergeIceServers(primary: RTCIceServer[], secondary: RTCIceServer[] | undefined): RTCIceServer[] {
  return [...primary, ...(secondary ?? [])];
}

function isPointerTool(tool: ComputerUseToolName): boolean {
  return ["left_click", "right_click", "middle_click", "double_click", "mouse_move"].includes(tool);
}

function areDecisionsNearDuplicate(previous: AgentDecision | null, next: AgentDecision): boolean {
  if (!previous || previous.tool !== next.tool) {
    return false;
  }

  if (isPointerTool(previous.tool)) {
    const previousPoint = previous.input.coordinate;
    const nextPoint = next.input.coordinate;
    if (!previousPoint || !nextPoint) {
      return false;
    }

    const dx = previousPoint[0] - nextPoint[0];
    const dy = previousPoint[1] - nextPoint[1];
    return Math.sqrt(dx * dx + dy * dy) <= POINTER_DEDUPE_RADIUS_PX;
  }

  if (previous.tool === "left_click_drag") {
    const previousStart = previous.input.start_coordinate;
    const nextStart = next.input.start_coordinate;
    const previousEnd = previous.input.coordinate;
    const nextEnd = next.input.coordinate;
    if (!previousStart || !nextStart || !previousEnd || !nextEnd) {
      return false;
    }

    const startDx = previousStart[0] - nextStart[0];
    const startDy = previousStart[1] - nextStart[1];
    const endDx = previousEnd[0] - nextEnd[0];
    const endDy = previousEnd[1] - nextEnd[1];
    return (
      Math.sqrt(startDx * startDx + startDy * startDy) <= POINTER_DEDUPE_RADIUS_PX &&
      Math.sqrt(endDx * endDx + endDy * endDy) <= POINTER_DEDUPE_RADIUS_PX
    );
  }

  return JSON.stringify(previous) === JSON.stringify(next);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function copyToExactUint8Array(view: Uint8Array): Uint8Array {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

function describeByteView(view: Uint8Array): string {
  const ctor = view.constructor?.name ?? "unknown";
  const length = "length" in view ? String((view as { length?: number }).length ?? "n/a") : "n/a";
  return `ctor=${ctor} length=${length} byteLength=${view.byteLength} byteOffset=${view.byteOffset} bufferByteLength=${view.buffer.byteLength} bpe=${view.BYTES_PER_ELEMENT}`;
}

function resizeRgbaNearestNeighbor(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return copyToExactUint8Array(source);
  }

  const target = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth));
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      target[targetIndex] = source[sourceIndex];
      target[targetIndex + 1] = source[sourceIndex + 1];
      target[targetIndex + 2] = source[sourceIndex + 2];
      target[targetIndex + 3] = source[sourceIndex + 3];
    }
  }
  return target;
}

export class OvershootCliAgent {
  private readonly logs: LogEntry[] = [];
  private readonly createdAt = new Date().toISOString();
  private updatedAt = this.createdAt;
  private status: SessionStatus = "starting";
  private history: ActionRecord[] = [];
  private latestModelOutput: string | null = null;
  private latestError: string | null = null;
  private streamId: string | null = null;
  private prompt = "";
  private readonly executor;
  private readonly capturer = new MacOSScreenCaptureBridge();
  private readonly computerUseState: ComputerUseStateStore;
  private readonly client: StreamClient;
  private readonly videoSource = new RTCVideoSource({ isScreencast: true });
  private readonly videoTrack = this.videoSource.createTrack();
  private peerConnection: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private captureTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private running = false;
  private lastActionSignature: string | null = null;
  private lastActionAt = 0;
  private lastAction: AgentDecision | null = null;
  private consecutiveWaits = 0;
  private recentWaitDescriptions: string[] = [];
  private lastPromptWaitCount = -1;
  private lastFrameGeometry: FrameGeometry | null = null;
  private repeatedActionCount = 0;
  private repeatedActionSuppressedUntil = 0;
  private verificationFramesSinceLastAction = 0;
  private verificationPending = false;
  private stopScheduled = false;
  private remainingFrameDebugLogs = 3;

  constructor(
    private readonly id: string,
    private readonly config: AppConfig,
    private readonly input: CreateSessionInput,
  ) {
    this.executor = createActionExecutor(input.executor ?? config.defaultExecutor);
    this.computerUseState = new ComputerUseStateStore(input.displayId);
    this.client = new StreamClient({
      apiKey: config.overshootApiKey,
      baseUrl: config.overshootApiUrl,
    });
  }

  async start(): Promise<void> {
    const displays = await this.capturer.listDisplays();
    this.computerUseState.setAvailableDisplays(displays);
    this.prompt = buildAgentPrompt({
      task: this.input.task,
      strategy: this.input.strategy,
      teachContext: this.input.teachContext,
      history: this.history,
      computerUseState: this.computerUseState.getState(),
      consecutiveWaits: this.consecutiveWaits,
      recentWaitDescriptions: this.recentWaitDescriptions,
      verificationNote: this.getVerificationNote(),
    });
    this.log("info", `[run-prompt-debug] promptLength=${this.prompt.length} teachContextLength=${this.input.teachContext?.length ?? 0}`);

    const baseIceServers = normalizeIceServers(this.config.webrtcIceUrls);
    const initial = await this.createOvershootStream(baseIceServers);

    let response = initial.response;
    let peerConnection = initial.peerConnection;

    if ((response.turn_servers?.length ?? 0) > 0) {
      this.log("info", "Overshoot returned TURN servers; recreating WebRTC peer with relay support.");
      await this.client.closeStream(response.stream_id).catch(() => undefined);
      peerConnection.close();

      const mergedIceServers = mergeIceServers(baseIceServers, response.turn_servers);
      const retried = await this.createOvershootStream(mergedIceServers);
      response = retried.response;
      peerConnection = retried.peerConnection;
    }

    this.peerConnection = peerConnection;
    this.streamId = response.stream_id;
    this.status = "running";
    this.running = true;
    this.touch();
    this.log("info", `Overshoot stream started with id ${response.stream_id}.`);

    this.setupWebSocket(response.stream_id);
    this.setupKeepalive(response.lease?.ttl_seconds ?? 30);
    await this.publishFrame();
    this.startCaptureLoop();
  }

  private async createOvershootStream(iceServers: RTCIceServer[]): Promise<{
    peerConnection: RTCPeerConnection;
    response: Awaited<ReturnType<StreamClient["createStream"]>>;
  }> {
    const peerConnection = new RTCPeerConnection({
      iceServers: iceServers.length > 0 ? iceServers : undefined,
    });

    this.attachPeerConnectionLogging(peerConnection);
    peerConnection.addTrack(this.videoTrack);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);

    const localSdp = peerConnection.localDescription?.sdp;
    if (!localSdp) {
      peerConnection.close();
      throw new Error("Failed to generate local WebRTC offer for Overshoot.");
    }

    const response = await this.client.createStream({
      source: {
        type: "webrtc",
        sdp: localSdp,
      },
      mode: "frame",
      processing: {
        interval_seconds: this.input.intervalSeconds,
      },
      inference: {
        prompt: this.prompt,
        backend: this.input.backend ?? "overshoot",
        model: this.input.model,
        output_schema_json: agentDecisionJsonSchema,
        ...(this.input.maxOutputTokens !== undefined ? { max_output_tokens: this.input.maxOutputTokens } : {}),
      },
      client: {
        request_id: this.id,
      },
    });

    if (!response.webrtc) {
      peerConnection.close();
      throw new Error("Overshoot did not return a WebRTC answer.");
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: response.webrtc.sdp,
    });

    return { peerConnection, response };
  }

  async stop(): Promise<void> {
    if (!this.running && this.status === "stopped") {
      return;
    }

    this.running = false;
    this.status = "stopping";
    this.touch();
    this.clearCaptureLoop();
    this.clearKeepalive();
    await this.waitForCaptureIdle();

    if (this.socket) {
      this.socket.close(1000, "client_requested");
      this.socket = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.videoTrack.stop();

    if (this.streamId) {
      await this.client.closeStream(this.streamId).catch(() => undefined);
      this.streamId = null;
    }

    this.status = "stopped";
    this.touch();
    this.log("info", "Stopped Overshoot CLI agent.");
  }

  getSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      streamId: this.streamId,
      task: this.input.task,
      strategy: this.input.strategy,
      teachContext: this.input.teachContext,
      model: this.input.model,
      intervalSeconds: this.input.intervalSeconds,
      latestModelOutput: this.latestModelOutput,
      latestError: this.latestError,
      prompt: this.prompt,
      history: [...this.history],
      logs: [...this.logs],
      computerUseState: this.computerUseState.getState(),
    };
  }

  private setupWebSocket(streamId: string): void {
    const socket = this.client.connectWebSocket(streamId);
    this.socket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ api_key: this.config.overshootApiKey }));
      this.log("info", "Overshoot WebSocket connected.");
    };

    socket.onmessage = (event) => {
      void this.handleSocketMessage(event.data);
    };

    socket.onerror = () => {
      this.log("error", "Overshoot WebSocket error.");
    };

    socket.onclose = (event) => {
      if (this.status === "stopped" || this.status === "stopping" || !this.running) {
        return;
      }

      const reason = event.reason || "WebSocket closed unexpectedly.";
      this.latestError = reason;
      this.status = "error";
      this.running = false;
      this.touch();
      this.log("error", `Overshoot WebSocket closed (${event.code}): ${reason}`);
    };
  }

  private setupKeepalive(ttlSeconds: number): void {
    const intervalMs = Math.max(5000, Math.floor((ttlSeconds * 1000) / 2));
    this.keepaliveTimer = setInterval(() => {
      void this.sendKeepalive();
    }, intervalMs);
  }

  private async sendKeepalive(): Promise<void> {
    if (!this.streamId || this.status !== "running") {
      return;
    }

    try {
      const response = await this.client.renewLease(this.streamId);
      this.log("info", `Lease renewed for ${response.ttl_seconds}s.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.log("error", `Keepalive failed: ${message}`);
    }
  }

  private startCaptureLoop(): void {
    const intervalMs = Math.max(100, Math.floor(1000 / this.config.captureFps));
    this.captureTimer = setInterval(() => {
      void this.publishFrame();
    }, intervalMs);
  }

  private clearCaptureLoop(): void {
    if (!this.captureTimer) {
      return;
    }
    clearInterval(this.captureTimer);
    this.captureTimer = null;
  }

  private clearKeepalive(): void {
    if (!this.keepaliveTimer) {
      return;
    }
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private async publishFrame(): Promise<void> {
    if (!this.running || this.captureInFlight) {
      return;
    }

    this.captureInFlight = true;
    let capturePath: string | null = null;

    try {
      const capture = await this.capturer.capture(this.computerUseState.getSelectedDisplayId());
      capturePath = capture.path;
      const png = PNG.sync.read(Buffer.from(capture.base64Png, "base64"));
      const expectedRgbaBytes = capture.display.width * capture.display.height * 4;
      if (this.remainingFrameDebugLogs > 0) {
        this.log(
          "info",
          `[run-frame-debug] display=${capture.display.width}x${capture.display.height} expectedRgbaBytes=${expectedRgbaBytes} png=${describeByteView(png.data)}`,
        );
      }
      const normalizedRgba = resizeRgbaNearestNeighbor(
        copyToExactUint8Array(png.data),
        png.width,
        png.height,
        capture.display.width,
        capture.display.height,
      );
      if (this.remainingFrameDebugLogs > 0) {
        this.log(
          "info",
          `[run-frame-debug] normalizedRgba=${describeByteView(normalizedRgba)}`,
        );
      }

      this.lastFrameGeometry = {
        imageWidth: capture.display.width,
        imageHeight: capture.display.height,
        displayWidth: capture.display.width,
        displayHeight: capture.display.height,
        originX: capture.display.originX,
        originY: capture.display.originY,
      };

      this.computerUseState.onScreenshotCaptured({
        width: capture.display.width,
        height: capture.display.height,
        displayWidth: capture.display.width,
        displayHeight: capture.display.height,
        displayId: capture.display.id,
        originX: capture.display.originX,
        originY: capture.display.originY,
      });

      const rgbaFrame = {
        width: capture.display.width,
        height: capture.display.height,
        data: normalizedRgba,
      };
      const i420Frame = {
        width: capture.display.width,
        height: capture.display.height,
        data: new Uint8Array(Math.floor((capture.display.width * capture.display.height * 3) / 2)),
      };
      if (this.remainingFrameDebugLogs > 0) {
        this.log(
          "info",
          `[run-frame-debug] i420=${describeByteView(i420Frame.data)}`,
        );
        this.remainingFrameDebugLogs -= 1;
      }

      rgbaToI420(rgbaFrame, i420Frame);
      this.videoSource.onFrame(i420Frame);
    } catch (error) {
      if (!this.running || this.status === "stopping" || this.status === "stopped") {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.status = "error";
      this.running = false;
      this.touch();
      this.log("error", `Frame publishing failed: ${message}`);
    } finally {
      this.captureInFlight = false;
      if (capturePath) {
        await this.capturer.cleanup(capturePath).catch(() => undefined);
      }
    }
  }

  private async handleSocketMessage(payload: unknown): Promise<void> {
    const raw = this.normalizeSocketPayload(payload);
    let result: StreamInferenceResult;

    try {
      result = JSON.parse(raw) as StreamInferenceResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.log("error", `Failed to parse Overshoot payload: ${message}`);
      return;
    }

    this.latestModelOutput = result.result;
    this.touch();

    if (!result.ok) {
      this.latestError = result.error ?? "Inference failed";
      this.log("error", `Inference failed: ${result.error ?? "unknown error"}`);
      return;
    }

    let decision: AgentDecision;
    try {
      decision = agentDecisionSchema.parse(JSON.parse(result.result) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.log("error", `Invalid model output: ${message}`);
      return;
    }

    if (decision.tool === "wait") {
      this.verificationFramesSinceLastAction += 1;
      this.consecutiveWaits += 1;
      this.recentWaitDescriptions = [...this.recentWaitDescriptions, decision.description].slice(
        -RECENT_WAIT_MEMORY,
      );
      if (/task complete/i.test(decision.description)) {
        if (this.canAcceptCompletion()) {
          this.log("info", `Model reports completion after verification: ${decision.description}`);
          this.scheduleStop("task_complete");
        } else {
          this.recentWaitDescriptions = [
            ...this.recentWaitDescriptions,
            "Completion was reported too early. The agent must observe at least two fresh verification frames after the last action before stopping.",
          ].slice(-RECENT_WAIT_MEMORY);
          this.log("info", `Ignoring premature completion until verification is complete: ${decision.description}`);
          await this.updatePrompt();
        }
        return;
      }
      this.log("info", `Model decided to wait: ${decision.description}`);

      if (this.shouldRefreshPromptAfterWait()) {
        await this.updatePrompt();
      }

      return;
    }

    this.consecutiveWaits = 0;
    this.verificationFramesSinceLastAction = 0;

    const signature = JSON.stringify({ tool: decision.tool, input: decision.input });
    const now = Date.now();
    if (
      now - this.lastActionAt < DEDUPE_WINDOW_MS &&
      (this.lastActionSignature === signature || areDecisionsNearDuplicate(this.lastAction, decision))
    ) {
      this.log("info", `Skipped duplicate tool action: ${decision.description}`);
      return;
    }

    if (
      now < this.repeatedActionSuppressedUntil &&
      areDecisionsNearDuplicate(this.lastAction, decision)
    ) {
      this.recentWaitDescriptions = [
        ...this.recentWaitDescriptions,
        "Repeated click on the same target was suppressed because the control may already be selected or the UI may need verification before another click.",
      ].slice(-RECENT_WAIT_MEMORY);
      if (this.shouldRefreshPromptAfterWait()) {
        await this.updatePrompt();
      }
      this.log("info", `Suppressed repeated action while waiting for visible confirmation: ${decision.description}`);
      return;
    }

    const previousAction = this.lastAction;
    const ack = await this.executeComputerUseDecision(decision);

    this.history = [
      ...this.history,
      {
        timestamp: new Date().toISOString(),
        status: ack.accepted ? "accepted" : "rejected",
        description: decision.description,
        tool: decision.tool,
        input: decision.input,
        responseMessage: ack.message,
      },
    ];

    if (ack.accepted) {
      this.lastActionSignature = signature;
      this.lastActionAt = now;
      this.lastAction = decision;
      this.verificationPending = true;
      if (areDecisionsNearDuplicate(previousAction, decision)) {
        this.repeatedActionCount += 1;
      } else {
        this.repeatedActionCount = 0;
      }

      if (isPointerTool(decision.tool) && this.repeatedActionCount >= REPEATED_POINTER_ACTION_THRESHOLD) {
        this.repeatedActionSuppressedUntil = now + REPEATED_POINTER_ACTION_COOLDOWN_MS;
        this.recentWaitDescriptions = [
          ...this.recentWaitDescriptions,
          "Repeated click on the same control was suppressed so the model should verify whether the control is already selected or choose a recovery action.",
        ].slice(-RECENT_WAIT_MEMORY);
        await this.updatePrompt();
      }
      this.log("info", `Action acknowledged: ${decision.description} | tool=${decision.tool} | input=${JSON.stringify(decision.input)}`);
    } else {
      this.log("error", `Action rejected: ${ack.message}`);
    }

    await this.updatePrompt();
  }

  private attachPeerConnectionLogging(peerConnection: RTCPeerConnection): void {
    peerConnection.addEventListener("connectionstatechange", () => {
      this.log("info", `Peer connection state: ${peerConnection.connectionState}`);
    });

    peerConnection.addEventListener("iceconnectionstatechange", () => {
      this.log("info", `ICE connection state: ${peerConnection.iceConnectionState}`);
    });

    peerConnection.addEventListener("icegatheringstatechange", () => {
      this.log("info", `ICE gathering state: ${peerConnection.iceGatheringState}`);
    });
  }

  private async executeComputerUseDecision(decision: AgentDecision): Promise<ActionAck> {
    if (decision.tool === "switch_display") {
      const targetDisplay = decision.input.display_id;
      if (targetDisplay === undefined) {
        return {
          accepted: false,
          message: "`switch_display` requires `display_id`.",
        };
      }

      const ack = this.computerUseState.switchDisplay(targetDisplay);
      if (ack.accepted) {
        await this.publishFrame();
      }

      return {
        accepted: ack.accepted,
        message: ack.message,
      };
    }

    const translatedAction = this.translateDecisionToComputerAction(decision);
    if (!translatedAction) {
      return {
        accepted: false,
        message: `Tool ${decision.tool} cannot be executed by the local executor.`,
      };
    }

    return await this.executor.execute({
      sessionId: this.id,
      description: decision.description,
      action: translatedAction,
    });
  }

  private async updatePrompt(): Promise<void> {
    if (!this.streamId) {
      return;
    }

    this.prompt = buildAgentPrompt({
      task: this.input.task,
      strategy: this.input.strategy,
      teachContext: this.input.teachContext,
      history: this.history,
      computerUseState: this.computerUseState.getState(),
      consecutiveWaits: this.consecutiveWaits,
      recentWaitDescriptions: this.recentWaitDescriptions,
      verificationNote: this.getVerificationNote(),
    });
    this.lastPromptWaitCount = this.consecutiveWaits;
    this.touch();
    await this.client.updatePrompt(this.streamId, this.prompt);
  }

  private shouldRefreshPromptAfterWait(): boolean {
    if (this.consecutiveWaits === 1) {
      return true;
    }

    if (this.consecutiveWaits >= WAIT_STREAK_RECOVERY_THRESHOLD) {
      return this.consecutiveWaits !== this.lastPromptWaitCount;
    }

    return this.consecutiveWaits % WAIT_PROMPT_REFRESH_INTERVAL === 0;
  }

  private normalizeSocketPayload(payload: unknown): string {
    if (typeof payload === "string") {
      return payload;
    }

    if (payload instanceof ArrayBuffer) {
      return Buffer.from(payload).toString("utf8");
    }

    if (ArrayBuffer.isView(payload)) {
      return Buffer.from(payload.buffer).toString("utf8");
    }

    return JSON.stringify(payload);
  }

  private log(level: LogEntry["level"], message: string): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(entry);
    if (this.logs.length > LOG_CAP) {
      this.logs.shift();
    }
    this.touch();
    const logger = level === "error" ? console.error : console.log;
    logger(`[agent:${this.id}] ${entry.timestamp} ${message}`);
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }

  private getVerificationNote(): string {
    if (!this.verificationPending) {
      return "No pending verification. If the task is already complete, use the `wait` tool with description `Task complete`.";
    }

    const remaining = Math.max(0, COMPLETION_VERIFICATION_FRAMES - this.verificationFramesSinceLastAction);
    return `A recent action was just taken. Do not declare task complete until you have observed at least ${COMPLETION_VERIFICATION_FRAMES} fresh follow-up frames after that action. Remaining verification frames: ${remaining}.`;
  }

  private canAcceptCompletion(): boolean {
    if (!this.verificationPending) {
      return true;
    }

    const ageMs = Date.now() - this.lastActionAt;
    const verified =
      this.verificationFramesSinceLastAction >= COMPLETION_VERIFICATION_FRAMES &&
      ageMs >= COMPLETION_VERIFICATION_MIN_AGE_MS;

    if (verified) {
      this.verificationPending = false;
    }

    return verified;
  }

  private scheduleStop(reason: string): void {
    if (this.stopScheduled) {
      return;
    }

    this.stopScheduled = true;
    setTimeout(() => {
      this.log("info", `Stopping after ${reason}.`);
      void this.stop();
    }, 0);
  }

  private async waitForCaptureIdle(): Promise<void> {
    const start = Date.now();
    while (this.captureInFlight && Date.now() - start < 1000) {
      await sleep(25);
    }
  }

  private translateDecisionToComputerAction(decision: AgentDecision): ComputerAction | null {
    const coordinate = this.translateCoordinate(decision.input.coordinate);
    const startCoordinate = this.translateCoordinate(decision.input.start_coordinate);

    switch (decision.tool) {
      case "left_click":
        return coordinate
          ? { type: "click", x: coordinate[0], y: coordinate[1], button: "left" }
          : null;
      case "right_click":
        return coordinate
          ? { type: "right_click", x: coordinate[0], y: coordinate[1], button: "right" }
          : null;
      case "middle_click":
        return coordinate
          ? { type: "click", x: coordinate[0], y: coordinate[1], button: "middle" }
          : null;
      case "double_click":
        return coordinate
          ? { type: "double_click", x: coordinate[0], y: coordinate[1], button: "left" }
          : null;
      case "mouse_move":
        return coordinate ? { type: "move", x: coordinate[0], y: coordinate[1] } : null;
      case "left_click_drag":
        return coordinate && startCoordinate
          ? {
              type: "drag",
              x: startCoordinate[0],
              y: startCoordinate[1],
              endX: coordinate[0],
              endY: coordinate[1],
            }
          : null;
      case "scroll":
        return {
          type: "scroll",
          x: coordinate?.[0],
          y: coordinate?.[1],
          ...this.scrollInputToDeltas(decision.input.direction, decision.input.amount),
        };
      case "type":
        return decision.input.text ? { type: "type", text: decision.input.text } : null;
      case "key":
        return decision.input.text ? { type: "keypress", key: decision.input.text } : null;
      default:
        return null;
    }
  }

  private scrollInputToDeltas(
    direction: AgentDecision["input"]["direction"],
    amount: AgentDecision["input"]["amount"],
  ): Pick<ComputerAction, "deltaX" | "deltaY"> {
    const magnitude = Math.max(1, Math.round(amount ?? 0));
    switch (direction) {
      case "up":
        return { deltaX: 0, deltaY: magnitude };
      case "down":
        return { deltaX: 0, deltaY: -magnitude };
      case "left":
        return { deltaX: magnitude, deltaY: 0 };
      case "right":
        return { deltaX: -magnitude, deltaY: 0 };
      default:
        return { deltaX: 0, deltaY: 0 };
    }
  }

  private translateCoordinate(coordinate: AgentDecision["input"]["coordinate"]): [number, number] | undefined {
    if (!coordinate) {
      return undefined;
    }

    const translated = this.translatePointToDisplaySpace(coordinate[0], coordinate[1]);
    return translated ? [translated.x, translated.y] : undefined;
  }

  private translatePointToDisplaySpace(x: number | undefined, y: number | undefined): { x: number; y: number } | undefined {
    const geometry = this.lastFrameGeometry;
    if (!geometry || typeof x !== "number" || typeof y !== "number") {
      return undefined;
    }

    const scaleX = geometry.displayWidth / geometry.imageWidth;
    const scaleY = geometry.displayHeight / geometry.imageHeight;
    return {
      x: clamp(Math.round(geometry.originX + x * scaleX), geometry.originX, geometry.originX + geometry.displayWidth),
      y: clamp(Math.round(geometry.originY + y * scaleY), geometry.originY, geometry.originY + geometry.displayHeight),
    };
  }
}
