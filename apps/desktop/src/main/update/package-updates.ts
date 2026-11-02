// The Linux .deb's updates: checks only. apt owns a .deb install, so Gram never downloads, writes or
// runs anything for it; a check finds the newest release that carries the .deb (and the AppImage's
// `latest-linux.yml`, so the release is complete) and links to its page. The same reducer as the
// other installs keeps the pill and Settings → Updates in step, with `target: "deb"` and
// `canInstall: false`, which the reducer enforces too.
import type { AppUpdateState, UpdateChannel } from "@gram/contracts";
import {
  backgroundCheckAllowed,
  initialNativeUpdateState,
  nativeReleasePage,
  reduceNativeUpdate,
  type NativeUpdateEvent,
} from "@gram/shell/modules/update";

import type { ReleaseFeed } from "./native-feed.ts";
import {
  CHECK_INTERVAL_MS,
  oneLine,
  plainNotes,
  STARTUP_CHECK_DELAY_MS,
  type NativeUpdates,
} from "./native-updates.ts";

export interface PackageUpdatesOptions {
  /** The feed for the `deb` target: it picks, and never downloads. */
  readonly feed: Pick<ReleaseFeed, "latest" | "picked">;
  readonly repo: string;
  readonly currentVersion: string;
  readonly readPrefs: () => Promise<{
    readonly channel: UpdateChannel;
    readonly automaticChecks?: boolean | undefined;
  }>;
  readonly timersAllowed: boolean;
  readonly ordinaryQuit: () => void;
  readonly broadcast: (state: AppUpdateState) => void;
  readonly log: (level: "info" | "warn", message: string) => void;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
}

const NOT_HERE =
  "Gram installed from the .deb doesn't update itself. Download the new .deb from the release page and install it with apt.";

export function createPackageUpdates(options: PackageUpdatesOptions): NativeUpdates {
  const { feed, log } = options;
  const now = options.now ?? Date.now;
  const later = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const every = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  let state = initialNativeUpdateState({
    currentVersion: options.currentVersion,
    channel: "stable",
    canInstall: false,
    target: "deb",
  });
  let launch: Promise<void> | undefined;
  let disposed = false;

  const apply = (event: NativeUpdateEvent): AppUpdateState => {
    const next = reduceNativeUpdate(state, event);
    if (next !== state) {
      state = next;
      options.broadcast(state);
    }
    return state;
  };

  async function check(channel: UpdateChannel, manual: boolean): Promise<AppUpdateState> {
    await start();
    if (disposed || state.status === "checking") return state;
    apply({ type: "checkStarted", channel, manual });
    try {
      const info = await feed.latest(channel);
      const picked = feed.picked();
      if (disposed) return state;
      // The feed offers only newer releases of the channel; anything else is the running version.
      if (!picked || picked.version !== info.version || info.version === options.currentVersion)
        return apply({ type: "upToDate", at: now() });
      return apply({
        type: "available",
        version: picked.version,
        notes: plainNotes(picked.notes),
        date: picked.publishedAt,
        at: now(),
        releaseUrl: nativeReleasePage(options.repo, picked.tag),
      });
    } catch (error) {
      log("warn", `update: check failed: ${error instanceof Error ? error.stack : String(error)}`);
      return apply({ type: "checkFailed", message: oneLine(error), at: now() });
    }
  }

  function start(): Promise<void> {
    launch ??= (async () => {
      const prefs = await options.readPrefs().catch(() => ({ channel: "stable" as const }));
      state = { ...state, channel: prefs.channel };
      options.broadcast(state);
      if (!options.timersAllowed || disposed) return;
      const tick = async () => {
        const current = await options.readPrefs().catch(() => undefined);
        if (current?.automaticChecks !== true || !backgroundCheckAllowed(state)) return;
        await check(current.channel, false);
      };
      later(() => void tick(), STARTUP_CHECK_DELAY_MS);
      every(() => void tick(), CHECK_INTERVAL_MS);
    })();
    return launch;
  }

  return {
    state: () => state,
    start,
    check,
    // Nothing downloads or installs: these only say so, and leave the state as it is.
    async download() {
      await start();
      log("warn", `update: refused a download on a .deb install: ${NOT_HERE}`);
      return state;
    },
    async install() {
      await start();
      log("warn", `update: refused an install on a .deb install: ${NOT_HERE}`);
      return state;
    },
    async dismiss() {
      await start();
      return disposed ? state : apply({ type: "dismissed" });
    },
    quitNeedsFence: () => false,
    async quitThroughFence() {
      options.ordinaryQuit();
    },
    async dispose() {
      disposed = true;
    },
  };
}
