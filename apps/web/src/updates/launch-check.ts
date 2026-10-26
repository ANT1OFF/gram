import type { ReleaseInfo, UpdateCheck } from "@gram/contracts";

/** How long a running app waits after one automatic check before the next. */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateDecision {
  /** The release to announce; absent means stay quiet. */
  readonly announce?: { readonly version: string; readonly tag: string };
  /** The pin no longer matches the running version, so it should be removed. */
  readonly clearPin: boolean;
}

/**
 * What an automatic check should surface. A newer release is announced unless the user pinned the
 * running version (a deliberate downgrade or hold). A pin that doesn't match the running version
 * was overtaken by an update from elsewhere, so it's cleared and the release is announced.
 */
export function decideUpdateNotice(
  check: UpdateCheck,
  pinnedVersion: string | undefined,
): UpdateDecision {
  if (!check.available || !check.latestVersion || !check.tag) return { clearPin: false };
  if (pinnedVersion !== undefined && pinnedVersion === check.currentVersion) {
    return { clearPin: false };
  }
  return {
    announce: { version: check.latestVersion, tag: check.tag },
    clearPin: pinnedVersion !== undefined,
  };
}

/**
 * The pin to store before installing `tag` from `releases` (newest first): none for the channel's
 * newest release, otherwise the chosen version, so the next launch doesn't offer to undo the choice.
 */
export function pinForInstall(releases: readonly ReleaseInfo[], tag: string): string | null {
  const chosen = releases.find((release) => release.tag === tag);
  return !chosen || chosen.tag === releases[0]?.tag ? null : chosen.version;
}

export interface UpdateWatchOptions {
  readonly check: () => Promise<UpdateCheck>;
  readonly onResult: (check: UpdateCheck) => void;
  readonly intervalMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/**
 * Checks at once, then `intervalMs` after each check settles, until the returned stop function
 * runs. A failed check produces no result and waits for the next round.
 */
export function startUpdateWatch(options: UpdateWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown;

  const round = () => {
    options
      .check()
      .then(
        (result) => {
          if (!stopped) options.onResult(result);
        },
        () => {},
      )
      .finally(() => {
        if (!stopped) timer = setTimer(round, intervalMs);
      });
  };
  round();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}
