import type { ComputerUseDisplayInfo, ComputerUseScreenshotDims, ComputerUseState } from "./types.js";

function cloneDisplays(displays: readonly ComputerUseDisplayInfo[]): ComputerUseDisplayInfo[] {
  return displays.map((display) => ({ ...display }));
}

function getMainDisplay(displays: readonly ComputerUseDisplayInfo[]): ComputerUseDisplayInfo | undefined {
  return displays.find((display) => display.isMain) ?? displays[0];
}

export class ComputerUseStateStore {
  private state: ComputerUseState;

  constructor(initialDisplayId?: number) {
    this.state = {
      selectedDisplayId: initialDisplayId,
      displayPinnedByModel: initialDisplayId !== undefined,
      displayResolvedForApps: undefined,
      lastScreenshotDims: undefined,
      availableDisplays: [],
    };
  }

  getState(): ComputerUseState {
    return {
      ...this.state,
      lastScreenshotDims: this.state.lastScreenshotDims ? { ...this.state.lastScreenshotDims } : undefined,
      availableDisplays: cloneDisplays(this.state.availableDisplays),
    };
  }

  setAvailableDisplays(displays: readonly ComputerUseDisplayInfo[]): void {
    this.state.availableDisplays = cloneDisplays(displays);
    if (this.state.selectedDisplayId === undefined) {
      this.state.selectedDisplayId = getMainDisplay(displays)?.id;
      return;
    }

    const selectedStillExists = displays.some((display) => display.id === this.state.selectedDisplayId);
    if (!selectedStillExists) {
      this.state.selectedDisplayId = getMainDisplay(displays)?.id;
      this.state.displayPinnedByModel = false;
      this.state.displayResolvedForApps = undefined;
    }
  }

  getSelectedDisplayId(): number | undefined {
    return this.state.selectedDisplayId;
  }

  getMainDisplayId(): number | undefined {
    return getMainDisplay(this.state.availableDisplays)?.id;
  }

  switchDisplay(displayId: number | "auto"): { accepted: boolean; message: string } {
    if (displayId === "auto") {
      const mainDisplayId = this.getMainDisplayId();
      this.state.selectedDisplayId = mainDisplayId;
      this.state.displayPinnedByModel = false;
      this.state.displayResolvedForApps = undefined;
      return {
        accepted: mainDisplayId !== undefined,
        message:
          mainDisplayId !== undefined
            ? `Switched back to the main display (${mainDisplayId}).`
            : "No display information is available yet.",
      };
    }

    const display = this.state.availableDisplays.find((item) => item.id === displayId);
    if (!display) {
      return {
        accepted: false,
        message: `Display ${displayId} is not available in the current session.`,
      };
    }

    this.state.selectedDisplayId = display.id;
    this.state.displayPinnedByModel = true;
    this.state.displayResolvedForApps = undefined;
    return {
      accepted: true,
      message: `Switched to display ${display.id}.`,
    };
  }

  onScreenshotCaptured(dims: ComputerUseScreenshotDims): void {
    this.state.lastScreenshotDims = { ...dims };
    this.state.selectedDisplayId = dims.displayId ?? this.state.selectedDisplayId;
  }
}
