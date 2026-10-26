// The signed-install updater's state machine (Electron's updater on Squirrel.Mac): one pure
// reducer, so main, the pill and Settings → Updates move through the same states. Main owns the
// timing and the side effects (`apps/desktop/src/main/update/native-updates.ts`).
import type { AppUpdateState, UpdateChannel } from "@gram/contracts";

export type NativeUpdateEvent =
  | { readonly type: "checkStarted"; readonly channel: UpdateChannel; readonly manual: boolean }
  | {
      readonly type: "available";
      readonly version: string;
      readonly notes: string | null;
      readonly date: string | null;
      readonly at: number;
    }
  | { readonly type: "upToDate"; readonly at: number }
  | { readonly type: "checkFailed"; readonly message: string; readonly at: number }
  | { readonly type: "downloadStarted" }
  | { readonly type: "downloadProgress"; readonly percent: number }
  | { readonly type: "downloadFailed"; readonly message: string }
  | { readonly type: "downloaded"; readonly version: string }
  | { readonly type: "installStarted" }
  /**
   * The restart was refused and nothing quit. `step` is what a retry has to do again when it
   * isn't the restart: check (the channel changed) or download (the file no longer verifies).
   */
  | {
      readonly type: "installRefused";
      readonly message: string;
      readonly step?: "check" | "download";
    }
  /** The restart can't finish or be undone yet: Gram stays stopped, saying why. */
  | { readonly type: "installHeld"; readonly message: string }
  /** macOS has an earlier install pending that Gram couldn't remove: held as an update, from any state. */
  | { readonly type: "pendingInstall"; readonly message: string }
  /** That pending install is shown gone: back to normal. */
  | { readonly type: "pendingCleared" }
  | { readonly type: "notApplied"; readonly version: string; readonly reason: string }
  | { readonly type: "dismissed" };

export function initialNativeUpdateState(options: {
  readonly currentVersion: string;
  readonly channel: UpdateChannel;
  readonly canInstall: boolean;
}): AppUpdateState {
  return {
    status: "idle",
    channel: options.channel,
    currentVersion: options.currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: null,
    releaseDate: null,
    percent: null,
    checkedAt: null,
    manual: false,
    message: null,
    errorStep: null,
    notApplied: null,
    canInstall: options.canInstall,
  };
}

const clamp = (percent: number) =>
  Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;

/** What a ready download looks like again after a check that didn't replace it. */
const stillReady = (state: AppUpdateState, at: number): AppUpdateState => ({
  ...state,
  status: "ready",
  availableVersion: state.downloadedVersion,
  percent: 100,
  checkedAt: at,
  message: null,
  errorStep: null,
});

/**
 * The next state after `event`. An event that doesn't apply to the current state (progress after
 * the download finished, a download start with nothing available) leaves it as it is, so a late
 * or duplicate updater event can't move the machine backwards.
 */
export function reduceNativeUpdate(
  state: AppUpdateState,
  event: NativeUpdateEvent,
): AppUpdateState {
  switch (event.type) {
    case "checkStarted": {
      if (state.status === "downloading" || state.status === "installing") return state;
      // Another channel's release is never offered on this one, downloaded or not.
      const moved = event.channel !== state.channel;
      return {
        ...state,
        status: "checking",
        channel: event.channel,
        manual: event.manual,
        message: null,
        errorStep: null,
        percent: null,
        ...(moved
          ? {
              availableVersion: null,
              downloadedVersion: null,
              releaseNotes: null,
              releaseDate: null,
            }
          : {}),
      };
    }
    case "available": {
      if (state.status !== "checking") return state;
      const downloaded = state.downloadedVersion === event.version;
      return {
        ...state,
        status: downloaded ? "ready" : "available",
        availableVersion: event.version,
        downloadedVersion: downloaded ? event.version : null,
        releaseNotes: event.notes,
        releaseDate: event.date,
        percent: downloaded ? 100 : null,
        checkedAt: event.at,
        message: null,
        errorStep: null,
      };
    }
    case "upToDate":
      if (state.status !== "checking") return state;
      // A download the feed no longer offers (the release was withdrawn) isn't installed.
      return {
        ...state,
        status: "upToDate",
        availableVersion: null,
        downloadedVersion: null,
        releaseNotes: null,
        releaseDate: null,
        percent: null,
        checkedAt: event.at,
        message: null,
        errorStep: null,
      };
    case "checkFailed":
      if (state.status !== "checking") return state;
      // The verified download is still good; a failed check doesn't take it away.
      if (state.downloadedVersion !== null) return stillReady(state, event.at);
      return {
        ...state,
        status: "error",
        availableVersion: null,
        releaseNotes: null,
        releaseDate: null,
        percent: null,
        checkedAt: event.at,
        message: event.message,
        errorStep: "check",
      };
    case "downloadStarted":
      if (
        state.availableVersion === null ||
        !(
          state.status === "available" ||
          (state.status === "error" && state.errorStep === "download")
        )
      )
        return state;
      return { ...state, status: "downloading", percent: 0, message: null, errorStep: null };
    case "downloadProgress":
      if (state.status !== "downloading") return state;
      return { ...state, percent: Math.max(state.percent ?? 0, clamp(event.percent)) };
    case "downloadFailed":
      if (state.status !== "downloading") return state;
      return {
        ...state,
        status: "error",
        percent: null,
        message: event.message,
        errorStep: "download",
      };
    case "downloaded":
      if (state.status !== "downloading" || event.version !== state.availableVersion) return state;
      return {
        ...state,
        status: "ready",
        downloadedVersion: event.version,
        percent: 100,
        message: null,
        errorStep: null,
      };
    case "installStarted":
      if (
        state.downloadedVersion === null ||
        !(state.status === "ready" || (state.status === "error" && state.errorStep === "install"))
      )
        return state;
      return {
        ...state,
        status: "installing",
        message: null,
        errorStep: null,
        notApplied: null,
      };
    case "installRefused":
      if (state.status !== "installing") return state;
      if (event.step === "download")
        return {
          ...state,
          status: "error",
          downloadedVersion: null,
          percent: null,
          message: event.message,
          errorStep: "download",
        };
      return {
        ...state,
        status: "error",
        message: event.message,
        errorStep: event.step ?? "install",
        ...(event.step === "check" ? { manual: true, downloadedVersion: null, percent: null } : {}),
      };
    case "installHeld":
      if (state.status !== "installing") return state;
      return { ...state, message: event.message };
    case "pendingInstall":
      return {
        ...state,
        status: "installing",
        message: event.message,
        errorStep: null,
        percent: null,
      };
    case "pendingCleared":
      if (state.status !== "installing") return state;
      return {
        ...state,
        status: state.downloadedVersion !== null ? "ready" : "idle",
        message: null,
        errorStep: null,
      };
    case "notApplied":
      return { ...state, notApplied: { version: event.version, reason: event.reason } };
    case "dismissed": {
      if (state.status !== "error") return { ...state, notApplied: null };
      const status =
        state.downloadedVersion !== null
          ? "ready"
          : state.errorStep === "download" && state.availableVersion !== null
            ? "available"
            : "idle";
      return { ...state, status, notApplied: null, message: null, errorStep: null };
    }
  }
}

/** Whether a timer-driven check may start now: never over a download, a ready update or an install. */
export const backgroundCheckAllowed = (state: AppUpdateState): boolean =>
  state.status !== "checking" &&
  state.status !== "downloading" &&
  state.status !== "ready" &&
  state.status !== "installing" &&
  !(state.status === "error" && state.errorStep === "install");
