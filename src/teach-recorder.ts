import wrtc from "@roamhq/wrtc";
import { PNG } from "pngjs";
import { StreamClient, type StreamInferenceResult } from "overshoot";

import { ComputerUseStateStore } from "./cua-state.js";
import { MacOSScreenCaptureBridge } from "./macos-capture.js";
import { MacOSInputObserver } from "./macos-observer.js";
import { teachAnnotationJsonSchema, teachAnnotationSchema } from "./teach-schema.js";
import { buildTeachPrompt } from "./teach-prompt.js";
import { TeachSessionStore } from "./teach-store.js";
import type {
  AppConfig,
  CreateTeachInput,
  LogEntry,
  SessionStatus,
  TeachAnnotation,
  TeachUserEvent,
} from "./types.js";

const { RTCPeerConnection, nonstandard } = wrtc;
const { RTCVideoSource, rgbaToI420 } = nonstandard;

const LOG_CAP = 200;
const ICE_GATHER_TIMEOUT_MS = 2500;
const MIN_APPEND_INTERVAL_MS = 1200;
const PROMPT_EVENT_MEMORY = 12;
const PROMPT_UPDATE_DEBOUNCE_MS = 300;

interface RecorderSnapshot {
  id: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  streamId: string | null;
  latestModelOutput: string | null;
  latestError: string | null;
  manifestPath: string;
  logs: LogEntry[];
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
  return urls.length > 0 ? [{ urls }] : [];
}

function mergeIceServers(primary: RTCIceServer[], secondary: RTCIceServer[] | undefined): RTCIceServer[] {
  return [...primary, ...(secondary ?? [])];
}

function copyToExactUint8Array(view: Uint8Array): Uint8Array {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
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

function describeByteView(view: Uint8Array): string {
  const ctor = view.constructor?.name ?? "unknown";
  const length = "length" in view ? String((view as { length?: number }).length ?? "n/a") : "n/a";
  return `ctor=${ctor} length=${length} byteLength=${view.byteLength} byteOffset=${view.byteOffset} bufferByteLength=${view.buffer.byteLength} bpe=${view.BYTES_PER_ELEMENT}`;
}

export class OvershootTeachRecorder {
  private readonly logs: LogEntry[] = [];
  private readonly createdAt = new Date().toISOString();
  private updatedAt = this.createdAt;
  private status: SessionStatus = "starting";
  private latestModelOutput: string | null = null;
  private latestError: string | null = null;
  private streamId: string | null = null;
  private readonly capturer = new MacOSScreenCaptureBridge();
  private readonly observer = new MacOSInputObserver();
  private readonly computerUseState: ComputerUseStateStore;
  private readonly client: StreamClient;
  private readonly videoSource = new RTCVideoSource({ isScreencast: true });
  private readonly videoTrack = this.videoSource.createTrack();
  private readonly storePromise: Promise<TeachSessionStore>;
  private peerConnection: RTCPeerConnection | null = null;
  private socket: WebSocket | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private captureTimer: NodeJS.Timeout | null = null;
  private captureInFlight = false;
  private running = false;
  private lastAnnotationSignature: string | null = null;
  private lastAppendAt = 0;
  private lastCapturePngBuffer: Buffer | null = null;
  private pendingUserEvents: TeachUserEvent[] = [];
  private recentObservedEvents: TeachUserEvent[] = [];
  private promptUpdateTimer: NodeJS.Timeout | null = null;
  private prompt = "";
  private manifestPath = "";
  private remainingFrameDebugLogs = 3;

  constructor(
    private readonly id: string,
    private readonly config: AppConfig,
    private readonly input: CreateTeachInput,
  ) {
    this.computerUseState = new ComputerUseStateStore(input.displayId);
    this.client = new StreamClient({
      apiKey: config.overshootApiKey,
      baseUrl: config.overshootApiUrl,
    });
    this.storePromise = TeachSessionStore.create({
      id,
      name: input.name,
      task: input.task,
    });
  }

  async start(): Promise<void> {
    const displays = await this.capturer.listDisplays();
    this.computerUseState.setAvailableDisplays(displays);
    const store = await this.storePromise;
    store.setAvailableDisplays(displays);
    this.manifestPath = store.getManifestPath();
    await this.observer.start((event) => {
      void this.handleObservedEvent(event);
    });

    this.prompt = buildTeachPrompt({
      task: this.input.task,
      recentEventContext: undefined,
    });

    const baseIceServers = normalizeIceServers(this.config.webrtcIceUrls);
    const initial = await this.createOvershootStream(baseIceServers);

    let response = initial.response;
    let peerConnection = initial.peerConnection;

    if ((response.turn_servers?.length ?? 0) > 0) {
      this.log("info", "Overshoot returned TURN servers; recreating teach WebRTC peer with relay support.");
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
    this.log("info", `Teach session started with stream id ${response.stream_id}.`);

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
        output_schema_json: teachAnnotationJsonSchema,
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

    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }

    if (this.promptUpdateTimer) {
      clearTimeout(this.promptUpdateTimer);
      this.promptUpdateTimer = null;
    }

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    const start = Date.now();
    while (this.captureInFlight && Date.now() - start < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (this.socket) {
      this.socket.close(1000, "client_requested");
      this.socket = null;
    }

    await this.observer.stop().catch(() => undefined);

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
    this.log("info", `Teach session saved to ${this.manifestPath}.`);
  }

  getSnapshot(): RecorderSnapshot {
    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      streamId: this.streamId,
      latestModelOutput: this.latestModelOutput,
      latestError: this.latestError,
      manifestPath: this.manifestPath,
      logs: [...this.logs],
    };
  }

  private setupWebSocket(streamId: string): void {
    const socket = this.client.connectWebSocket(streamId);
    this.socket = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ api_key: this.config.overshootApiKey }));
      this.log("info", "Teach WebSocket connected.");
    };

    socket.onmessage = (event) => {
      void this.handleSocketMessage(event.data);
    };

    socket.onerror = () => {
      this.log("error", "Teach WebSocket error.");
    };

    socket.onclose = (event) => {
      if (this.status === "stopped" || this.status === "stopping" || !this.running) {
        return;
      }

      const reason = event.reason || "Teach WebSocket closed unexpectedly.";
      this.latestError = reason;
      this.status = "error";
      this.running = false;
      this.touch();
      this.log("error", `Teach WebSocket closed (${event.code}): ${reason}`);
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
      this.log("info", `Teach lease renewed for ${response.ttl_seconds}s.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.log("error", `Teach keepalive failed: ${message}`);
    }
  }

  private startCaptureLoop(): void {
    const intervalMs = Math.max(100, Math.floor(1000 / this.config.captureFps));
    this.captureTimer = setInterval(() => {
      void this.publishFrame();
    }, intervalMs);
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
      this.lastCapturePngBuffer = Buffer.from(capture.base64Png, "base64");

      const png = PNG.sync.read(this.lastCapturePngBuffer);
      const expectedRgbaBytes = capture.display.width * capture.display.height * 4;
      if (this.remainingFrameDebugLogs > 0) {
        this.log(
          "info",
          `[teach-frame-debug] display=${capture.display.width}x${capture.display.height} pngSize=${png.width}x${png.height} expectedRgbaBytes=${expectedRgbaBytes} png=${describeByteView(png.data)}`,
        );
      }
      const normalizedRgba = resizeRgbaNearestNeighbor(
        copyToExactUint8Array(png.data),
        png.width,
        png.height,
        capture.display.width,
        capture.display.height,
      );
      const rgbaFrame = {
        width: capture.display.width,
        height: capture.display.height,
        data: normalizedRgba,
      };
      if (this.remainingFrameDebugLogs > 0) {
        this.log(
          "info",
          `[teach-frame-debug] copiedRgba=${describeByteView(rgbaFrame.data)}`,
        );
      }
      const i420Frame = {
        width: capture.display.width,
        height: capture.display.height,
        data: new Uint8Array(Math.floor((capture.display.width * capture.display.height * 3) / 2)),
      };
      if (this.remainingFrameDebugLogs > 0) {
        this.log(
          "info",
          `[teach-frame-debug] i420=${describeByteView(i420Frame.data)}`,
        );
        this.remainingFrameDebugLogs -= 1;
      }

      rgbaToI420(rgbaFrame, i420Frame);
      this.videoSource.onFrame(i420Frame);

      this.computerUseState.onScreenshotCaptured({
        width: capture.display.width,
        height: capture.display.height,
        displayWidth: capture.display.width,
        displayHeight: capture.display.height,
        displayId: capture.display.id,
        originX: capture.display.originX,
        originY: capture.display.originY,
      });

      const store = await this.storePromise;
      store.setLastScreenshotDims({
        width: capture.display.width,
        height: capture.display.height,
        displayWidth: capture.display.width,
        displayHeight: capture.display.height,
        displayId: capture.display.id,
        originX: capture.display.originX,
        originY: capture.display.originY,
      });
    } catch (error) {
      if (!this.running || this.status === "stopping" || this.status === "stopped") {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.status = "error";
      this.running = false;
      this.touch();
      this.log("error", `Teach frame publishing failed: ${message}`);
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
      this.log("error", `Failed to parse teach payload: ${message}`);
      return;
    }

    this.latestModelOutput = result.result;
    this.touch();

    if (!result.ok) {
      this.latestError = result.error ?? "Teach inference failed";
      this.log("error", `Teach inference failed: ${result.error ?? "unknown error"}`);
      return;
    }

    if (result.finish_reason === "length") {
      this.log(
        "error",
        `Teach output truncated at token limit; ignoring partial JSON. snippet=${JSON.stringify(result.result.slice(0, 200))}`,
      );
      return;
    }

    let annotation: TeachAnnotation;
    try {
      annotation = teachAnnotationSchema.parse(JSON.parse(result.result) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.latestError = message;
      this.log(
        "error",
        `Invalid teach model output: ${message} | finish_reason=${result.finish_reason ?? "null"} | snippet=${JSON.stringify(result.result.slice(0, 200))}`,
      );
      return;
    }

    const signature = JSON.stringify(annotation);
    const now = Date.now();
    if (signature === this.lastAnnotationSignature && now - this.lastAppendAt < MIN_APPEND_INTERVAL_MS) {
      return;
    }

    const store = await this.storePromise;
    const userEvents = this.pendingUserEvents;
    this.pendingUserEvents = [];
    await store.append(annotation, userEvents, this.lastCapturePngBuffer ?? undefined);
    this.lastAnnotationSignature = signature;
    this.lastAppendAt = now;
    this.log("info", `Teach annotation recorded: ${annotation.summary}`);
  }

  private async handleObservedEvent(event: TeachUserEvent): Promise<void> {
    this.pendingUserEvents.push(event);
    this.recentObservedEvents = [...this.recentObservedEvents, event].slice(-PROMPT_EVENT_MEMORY);
    const store = await this.storePromise;
    await store.appendRawEvent(event);
    this.schedulePromptUpdate();
  }

  private schedulePromptUpdate(): void {
    if (this.promptUpdateTimer) {
      return;
    }

    this.promptUpdateTimer = setTimeout(() => {
      this.promptUpdateTimer = null;
      void this.updatePrompt();
    }, PROMPT_UPDATE_DEBOUNCE_MS);
  }

  private async updatePrompt(): Promise<void> {
    if (!this.streamId || this.status !== "running") {
      return;
    }

    this.prompt = buildTeachPrompt({
      task: this.input.task,
      recentEventContext: this.formatRecentObservedEvents(),
    });
    await this.client.updatePrompt(this.streamId, this.prompt);
  }

  private formatRecentObservedEvents(): string | undefined {
    if (this.recentObservedEvents.length === 0) {
      return undefined;
    }

    return this.recentObservedEvents
      .map((event, index) => `${index + 1}. ${this.describeObservedEvent(event)}`)
      .join("\n");
  }

  private describeObservedEvent(event: TeachUserEvent): string {
    switch (event.type) {
      case "key_down":
        return `${event.frontmostApp ?? "unknown app"}: key ${event.key ?? "unknown"}${event.modifiers?.length ? ` with ${event.modifiers.join("+")}` : ""}`;
      case "scroll":
        return `${event.frontmostApp ?? "unknown app"}: scroll dx=${event.deltaX ?? 0} dy=${event.deltaY ?? 0}`;
      default:
        return `${event.frontmostApp ?? "unknown app"}: ${event.type} at (${event.x ?? 0}, ${event.y ?? 0})`;
    }
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

  private attachPeerConnectionLogging(peerConnection: RTCPeerConnection): void {
    peerConnection.addEventListener("connectionstatechange", () => {
      this.log("info", `Teach peer connection state: ${peerConnection.connectionState}`);
    });
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
    logger(`[teach:${this.id}] ${entry.timestamp} ${message}`);
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}
