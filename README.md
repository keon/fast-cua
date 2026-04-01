# Fast CUA CLI with Overshoot

This repo is now a **pure CLI-based Node.js + TypeScript computer-use agent for a local Mac screen using Overshoot**.

There is no browser UI, no HTTP server, and no LiveKit.

The agent:

1. captures the local Mac screen,
2. publishes those frames to Overshoot over WebRTC from the CLI,
3. receives a Claude-style computer-use tool call shaped like `{ tool, input, description }`,
4. executes real mouse/keyboard actions on macOS,
5. tracks simple computer-use state like selected display and last screenshot dimensions,
6. repeats.

It also supports a `teach` mode that records a live demonstration, captures your real mouse/keyboard activity, feeds recent observed events back into the teach prompt in real time, asks the model to annotate the UI and workflow, and saves both raw evidence and distilled semantic memory for later tasks.

## Commands

### Run the agent

```bash
pnpm dev -- run \
  --task "Open the settings menu and enable dark mode"
```

Optional extra steering:

```bash
pnpm dev -- run \
  --task "Open the settings menu and enable dark mode" \
  --strategy "Work step by step. If the UI is still changing, wait."
```

### List Overshoot models

```bash
pnpm dev -- models
```

### Record a teach session

```bash
pnpm dev -- teach \
  --name "mac-settings-dark-mode" \
  --task "Demonstrate how to enable dark mode in macOS settings"
```

This writes a teach manifest under `.teach/.../session.json`, annotated keyframe screenshots, a raw `events.jsonl` timeline of your observed input events, and a distilled `memory.json` semantic memory artifact.

### Save one screenshot

```bash
pnpm dev -- capture-once --output screenshot.png
```

### List displays

```bash
pnpm dev -- list-displays
```

### Build and run compiled CLI

```bash
pnpm build
pnpm start -- run \
  --task "Open the settings menu and enable dark mode"
```

### Run with learned memory from teach

```bash
pnpm dev -- run \
  --task "Enable dark mode again" \
  --teach-file .teach/<your-session>/session.json
```

## Run options

- `--task` required task description
- `--strategy` optional extra instructions for how to achieve the task
- `--teach-file` optional teach session manifest to load as prior context
- `--model` optional model override
- `--interval` optional frame interval in seconds
- `--display-id` optional macOS display id for screenshot capture
- `--backend` optional backend: `overshoot` or `gemini`
- `--max-output-tokens` optional max output tokens
- `--executor` optional executor: `macos_native`, `mock`, or `webhook`
- `--action-webhook-url` required when `--executor webhook`
- `--task-file` load task text from a file
- `--strategy-file` load strategy text from a file

Teach mode options:

- `--name` optional teach session name
- `--task` optional label describing what you are demonstrating
- `--model` optional model override
- `--interval` optional frame interval in seconds
- `--display-id` optional macOS display id for screenshot capture
- `--backend` optional backend: `overshoot` or `gemini`
- `--max-output-tokens` optional max output tokens

## How Overshoot is used

This CLI uses Overshoot’s low-level realtime API directly:

- `StreamClient.createStream(...)`
- `StreamClient.connectWebSocket(...)`
- `StreamClient.updatePrompt(...)`
- `StreamClient.renewLease(...)`

Instead of LiveKit, the CLI publishes the local Mac screen to Overshoot as a WebRTC video source.

That keeps the app:

- local-screen based,
- pure CLI,
- and still centered on Overshoot.

## macOS native control

When `ACTION_EXECUTOR_TYPE=macos_native` or `--executor macos_native`, the CLI compiles and uses `native/macos-input.swift:1`.

That helper executes real:

- mouse move
- click
- double click
- right click
- drag
- scroll
- text entry
- keypress

It uses macOS CGEvents, so it controls the actual mouse and keyboard.

Before using it, enable Accessibility permissions for your terminal or Node host in:

- `System Settings > Privacy & Security > Accessibility`

Without that permission, the native executor will refuse to act.

For local screenshot capture, also enable Screen Recording permission for your terminal or Node host in:

- `System Settings > Privacy & Security > Screen Recording`

## Environment

Create `.env.local` from the example:

```bash
cp .env.example .env.local
```

The CLI loads `.env.local` automatically.

Example `.env.local`:

```bash
OVERSHOOT_API_KEY="your-key"
OVERSHOOT_API_URL=""
DEFAULT_MODEL="Qwen/Qwen3-VL-30B-A3B-Instruct"
DEFAULT_INTERVAL_SECONDS=0.5
CAPTURE_FPS=4
WEBRTC_ICE_URLS="stun:stun.l.google.com:19302"
ACTION_EXECUTOR_TYPE=macos_native
```

## Key files

- `src/index.ts:1` is the CLI entrypoint
- `src/agent.ts:1` runs the Overshoot realtime loop from the CLI
- `src/macos-capture.ts:1` compiles and invokes the native capture helper
- `src/prompt.ts:1` builds the rolling task/memory prompt
- `src/schema.ts:1` defines the action JSON contract
- `src/executor.ts:1` selects the executor backend
- `src/macos-native.ts:1` compiles and invokes the native helper
- `native/macos-capture.swift:1` captures local display screenshots on macOS
- `native/macos-input.swift:1` sends real macOS input events

## Prompt loop

Each Overshoot inference sees:

- task to be done
- optional extra instructions for how to achieve the task
- computer-use state, including selected display and screenshot metadata
- actions attempted so far
- exact JSON response format

If you pass `--teach-file`, the run prompt also includes a summarized replayable context derived from your prior demonstration.
If `memory.json` exists for that teach session, `run` uses the distilled semantic memory instead of the raw session transcript.

The model must return either:

```json
{
  "tool": "wait",
  "input": {
    "duration": 1
  },
  "description": "Waiting for the transition to finish"
}
```

or:

```json
{
  "tool": "left_click",
  "input": {
    "coordinate": [932, 612]
  },
  "description": "Clicked the dark mode toggle"
}
```

It can also switch displays explicitly:

```json
{
  "tool": "switch_display",
  "input": {
    "display_id": "auto"
  },
  "description": "Switched back to the main display"
}
```

After each accepted or rejected tool action, the next prompt includes the updated action history plus the latest computer-use state so the agent retains short-term memory across steps.

## Teach mode

`teach` is the preferred name over `learn`.

- `teach` implies explicit user-guided demonstration
- `learn` sounds passive and continuous, which is better reserved for future automatic adaptation

The minimal architecture follows the same general shape as the leaked Claude Code computer-use stack:

- live screen stream into the model
- explicit in-process state store for display/screenshot context
- structured model output schema
- persisted session state that can be reused later

Each teach inference produces structured annotations instead of actions:

- current workflow summary
- visible app guess
- likely user goal guess
- important reusable UI components with location hints
- notable visual changes

Teach also records your actual observed inputs during the demonstration:

- mouse down/up events
- scroll events
- key down events
- frontmost app metadata at event time

Those annotations are saved together with keyframe screenshots and the raw event timeline under `.teach/` as evidence.

Then a separate semantic-memory distillation step produces `memory.json`, which is what later `run --teach-file ...` calls consume. This means the agent is guided by learned UI concepts, success conditions, and navigation hints rather than blindly replaying a workflow.
