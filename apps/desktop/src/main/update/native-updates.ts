// A signed install's updates through Electron's updater (electron-updater on Squirrel.Mac): checks
// on a timer once automatic checks are on, downloads when the user asks, and restarts into the
// update only after Gram's stop fence has attested sessions, the database and owned agents. A
// refused fence quits nothing. Electron itself stays behind `NativeUpdaterPort`, so every step and
// refusal here runs against a synthetic port in the tests.
import type { AppUpdateState, UpdateChannel, UpdateTeardown } from "@gram/contracts";
import {
  backgroundCheckAllowed,
  initialNativeUpdateState,
  parseVersion,
  reduceNativeUpdate,
  type NativeInstallRecord,
  type NativeUpdateEvent,
} from "@gram/shell/modules/update";

import type { CandidateSnapshot } from "./native-snapshot.ts";
import { UpdateTeardownRefused } from "./shutdown.ts";

/** The first automatic check waits for launch to settle. */
export const STARTUP_CHECK_DELAY_MS = 15_000;
/** Automatic checks after that. */
export const CHECK_INTERVAL_MS = 4 * 60_000;
/** One controller-owned budget for detecting/removing an earlier pending install. */
export const PENDING_DETECTION_DEADLINE_MS = 30_000;
/**
 * How long Squirrel.Mac may take to unpack and verify the update before Gram says it's still
 * waiting. Only the message changes: its outcome is joined, never raced, since once invoked it
 * may arm an install at any moment.
 */
export const STAGE_DEADLINE_MS = 3 * 60_000;
/** How long the app may take to quit into the staged update. */
export const QUIT_DEADLINE_MS = 60_000;

/** What the controller needs of electron-updater and Squirrel.Mac. */
export interface NativeUpdaterPort {
  /** Points the next check at `channel` on the public feed. */
  useFeed(channel: UpdateChannel): void;
  /** electron-updater's check: the newer release's info, or null with nothing newer. */
  check(): Promise<{
    readonly version: string;
    readonly notes: string | null;
    readonly date: string | null;
  } | null>;
  /** Downloads the checked update; resolves with the ZIP's path once its SHA-512 matched. */
  download(onPercent: (percent: number) => void): Promise<string>;
  /**
   * Hands the verified ZIP to Squirrel.Mac and resolves once it has unpacked it and checked its
   * code signature against this app's own designated requirement (same team, same identifier).
   * From then on an exit installs it. One attempt at a time; it never times out.
   */
  stage(snapshot: CandidateSnapshot, version: string): Promise<void>;
  /** Whether Squirrel.Mac's installer has an install pending; undefined when that can't be told. */
  pendingInstall(): Promise<boolean | undefined>;
  /** Removes a pending install; true only once macOS shows none left. */
  disarm(): Promise<boolean>;
  /** Squirrel.Mac's relaunch into the staged update. */
  quitAndInstall(): void;
}

export interface NativeUpdatesOptions {
  readonly port: NativeUpdaterPort;
  readonly currentVersion: string;
  /** Packaged, in Applications and writable: Squirrel.Mac can replace it. */
  readonly canInstall: boolean;
  readonly readPrefs: () => Promise<{
    readonly channel: UpdateChannel;
    readonly automaticChecks?: boolean | undefined;
  }>;
  /** Whether timers may check at all (not in smoke runs or CI); see `autoUpdateCheckEnabled`. */
  readonly timersAllowed: boolean;
  /**
   * Snapshots and checks a finished download before it can be offered for a restart (see
   * `snapshotCandidate` and `verifyNativeCandidate`): resolves with the verified snapshot, the
   * only bytes Squirrel.Mac is ever served.
   */
  readonly verifyDownload: (
    file: string,
    version: string,
    channel: UpdateChannel,
  ) => Promise<CandidateSnapshot>;
  /**
   * Gram's update stop: the server's attested teardown (sessions, database, owned agents, then
   * the rest killed), speech and window state. Rejects, having quit nothing, when it refuses.
   */
  readonly stopForUpdate: (signal: AbortSignal) => Promise<void>;
  /**
   * Runs the whole restart as Gram's one update transaction: a quit asked for meanwhile cancels
   * it instead of racing it.
   */
  readonly transaction: (work: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  /**
   * Brings the server, voice and windows back after this transaction's own refused stop.
   * An earlier unresolved install keeps every subsequent quit behind the stop fence.
   */
  readonly recover: () => Promise<string | undefined>;
  /** From here on a quit is the update's: exit at once, so Squirrel.Mac's installer runs. */
  readonly armQuit: () => void;
  /** Quits are ordinary again, once nothing is pending and Gram has recovered. */
  readonly disarmQuit: () => void;
  /** Ordinary quit, allowed only after launch has conclusively cleared any pending install. */
  readonly ordinaryQuit: () => void;
  readonly exit: () => void;
  readonly hideWindows: () => () => void;
  readonly record: {
    read(): Promise<NativeInstallRecord | undefined>;
    write(record: NativeInstallRecord): Promise<void>;
    remove(): Promise<void>;
  };
  /** Where Squirrel.Mac's installer writes its log, for a "not applied" notice. */
  readonly logHint: string;
  readonly judge: (
    record: NativeInstallRecord,
  ) =>
    | { readonly kind: "applied" | "stale" }
    | { readonly kind: "notApplied"; readonly version: string; readonly reason: string };
  readonly broadcast: (state: AppUpdateState) => void;
  readonly log: (level: "info" | "warn", message: string) => void;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export interface NativeUpdates {
  state(): AppUpdateState;
  /** Reads the last restart's record, then starts the automatic-check timers. */
  start(): Promise<void>;
  check(channel: UpdateChannel, manual: boolean): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  install(version: string): Promise<AppUpdateState>;
  /** Clears a notice; on a pending earlier install, tries again to remove it. */
  dismiss(): Promise<AppUpdateState>;
  /** A pending install Gram couldn't stop for: every quit must run the stop fence first. */
  quitNeedsFence(): boolean;
  /** The quit for that case: the fence, then exit; a refusal keeps Gram running and says why. */
  quitThroughFence(): Promise<void>;
  /** Releases abandoned downloads on shutdown. */
  dispose(): Promise<void>;
}

/** What a refused stop says, in one line; the full reason is in the log. */
const FENCE_REASON: Readonly<
  Record<Extract<UpdateTeardown, { path: "refused" }>["reason"], string>
> = {
  sessions: "agent sessions didn't save in time",
  agents: "an agent didn't stop cleanly",
  database: "the database couldn't be closed",
  survivor: "a server process survived its stop",
  unverified: "Gram couldn't confirm the server stopped",
  teardown: "the server didn't stop cleanly",
};

/** An error's message on one short line: electron-updater's can carry a stack or a whole feed. */
export function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = (text.split("\n").find((part) => part.trim() !== "") ?? "").trim();
  const short = line.replace(/\s+/g, " ").replace(/\s*\(https?:\/\/[^)]*\)/g, "");
  return short.length > 200 ? `${short.slice(0, 199)}…` : short || "Something went wrong.";
}

const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** Release notes as plain text: the public feed's are HTML from GitHub's release feed. */
export function plainNotes(notes: unknown): string | null {
  const text = Array.isArray(notes)
    ? notes
        .map((note: unknown) => (note as { note?: unknown } | null)?.note)
        .filter((note): note is string => typeof note === "string")
        .join("\n\n")
    : typeof notes === "string"
      ? notes
      : "";
  let stripped = text;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h\d)>/gi, "\n")
      .replace(/<[^>]*>/g, "");
  } while (stripped !== previous);
  // Decode only after stripping: entity-escaped examples remain literal text in the UI.
  const plain = stripped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain ? plain.slice(0, 8_000) : null;
}

export function createNativeUpdates(options: NativeUpdatesOptions): NativeUpdates {
  const { port, log } = options;
  const now = options.now ?? Date.now;
  const later = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const every = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const cancelLater =
    options.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  // Only observations are raced. The actual stop fence and Squirrel staging are always joined.
  // Late observations have no side effects on controller state or recovery authority.
  function detectionBudget() {
    let expired = false;
    let timer: unknown;
    const timeout = new Promise<undefined>((resolve) => {
      timer = later(() => {
        expired = true;
        resolve(undefined);
      }, PENDING_DETECTION_DEADLINE_MS);
    });
    return {
      async observe<T>(work: () => Promise<T>): Promise<{ value: T } | undefined> {
        if (expired) return undefined;
        const result = await Promise.race([
          Promise.resolve()
            .then(work)
            .then(
              (value) => ({ value }),
              () => undefined,
            ),
          timeout,
        ]);
        if (expired)
          log("warn", "update: pending-install detection timed out; treating it as unknown");
        return result;
      },
      close: () => cancelLater(timer),
    };
  }

  // A timed-out native disarm is still a mutation in flight. A retry may join it, but must never
  // start a competing disarm or restore services until an actual clear result is observed.
  let disarming: Promise<boolean> | undefined;
  function disarmPending(): Promise<boolean> {
    disarming ??= Promise.resolve()
      .then(() => port.disarm())
      .catch(() => false)
      .finally(() => {
        disarming = undefined;
      });
    return disarming;
  }

  async function boundedDisarm(): Promise<boolean> {
    const budget = detectionBudget();
    try {
      return (await budget.observe(disarmPending))?.value === true;
    } finally {
      budget.close();
    }
  }
  let state = initialNativeUpdateState({
    currentVersion: options.currentVersion,
    channel: "stable",
    canInstall: options.canInstall,
  });
  // Closed only by this controller's one launch operation, never by an unresolved native probe.
  let launchSettled = false;
  let launch: Promise<void> | undefined;
  let disposed = false;
  let staging = false;
  let quitFlight: Promise<void> | undefined;

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
    if (disposed || pendingHold) return state;
    if (state.status === "checking" || state.status === "downloading") return state;
    if (state.status === "installing") return state;
    const moved = channel !== state.channel;
    apply({ type: "checkStarted", channel, manual });
    if (moved) await forget();
    try {
      port.useFeed(channel);
      const found = await port.check();
      const version = found === null ? undefined : parseVersion(found.version);
      // The feed offers only newer releases; an RC is also only ever offered on Pre-release,
      // whatever the feed says.
      const offered =
        found !== null &&
        version !== null &&
        version !== undefined &&
        (channel === "prerelease" || version.pre.length === 0);
      if (disposed) return state;
      if (!offered) {
        await forget();
        return apply({ type: "upToDate", at: now() });
      }
      if (verified?.version !== found.version) await forget();
      return apply({
        type: "available",
        version: found.version,
        notes: found.notes,
        date: found.date,
        at: now(),
      });
    } catch (error) {
      log("warn", `update: check failed: ${error instanceof Error ? error.stack : String(error)}`);
      return apply({ type: "checkFailed", message: oneLine(error), at: now() });
    }
  }

  /** The download a restart may install: its version and its verified snapshot. */
  let verified: { version: string; snapshot: CandidateSnapshot } | undefined;
  let releasing: Promise<void> = Promise.resolve();
  const forget = () => {
    const previous = verified;
    verified = undefined;
    if (previous) releasing = releasing.then(() => previous.snapshot.close());
    return releasing;
  };

  /**
   * Set while macOS has an install pending that Gram couldn't remove: `fenced` once the stop fence
   * has passed (quitting is the safe way out), `running` when it refused and everything came back
   * (every quit then runs the fence first).
   */
  let pendingHold: "fenced" | "running" | undefined;
  const PENDING =
    "macOS has an earlier update waiting to install, so Gram has stopped. Quitting is safe and lets it install; or try again to remove it.";

  // Read through a function so the narrowing on `pendingHold` doesn't outlive the awaits.
  const quitsFreely = () => pendingHold === "fenced";

  /** Stops as an update stops, before any exit an earlier pending install could ride on. */
  async function holdForPending(): Promise<void> {
    if (pendingHold === "fenced") return;
    apply({
      type: "pendingInstall",
      message: "macOS has an earlier update waiting to install. Gram is stopping for it.",
    });
    let showWindows: (() => void) | undefined;
    let stopped = false;
    try {
      await options.transaction(async (signal) => {
        showWindows = options.hideWindows();
        stopped = true;
        await options.stopForUpdate(signal);
      });
      pendingHold = "fenced";
      options.armQuit();
      showWindows?.();
      apply({ type: "pendingInstall", message: PENDING });
    } catch (error) {
      const reason =
        error instanceof UpdateTeardownRefused
          ? FENCE_REASON[error.teardown.reason]
          : oneLine(error);
      log("warn", `update: couldn't stop for a pending macOS install: ${reason}`);
      let problem: string | undefined;
      // Admission refusal belongs to another transaction: it grants no recovery authority.
      if (stopped) {
        options.disarmQuit();
        try {
          problem = await options.recover();
        } catch (recovery) {
          problem = oneLine(recovery);
        }
      }
      showWindows?.();
      pendingHold = "running";
      apply({
        type: "pendingInstall",
        message: `macOS has an earlier update waiting to install, and Gram couldn't stop safely for it (${reason}). Quitting runs that stop again first.${problem ? ` ${problem}` : ""}`,
      });
    }
  }

  /** Detection, disarm, fencing and recovery share one owner and one outcome. */
  let pendingFlight: Promise<"clear" | "held"> | undefined;
  function pendingOperation(
    work: (budget: ReturnType<typeof detectionBudget>) => Promise<"clear" | "held">,
  ): Promise<"clear" | "held"> {
    if (!pendingFlight) {
      const budget = detectionBudget();
      pendingFlight = work(budget).finally(() => {
        budget.close();
        pendingFlight = undefined;
      });
    }
    return pendingFlight;
  }

  /** Whether nothing of an earlier attempt is pending in macOS any more; holds when unsure. */
  function settlePending(): Promise<"clear" | "held"> {
    return pendingOperation(async (budget) => {
      const pending = await budget.observe(() => port.pendingInstall());
      if (pending?.value === false) return "clear";
      if ((await budget.observe(disarmPending))?.value === true) return "clear";
      await holdForPending();
      return "held";
    });
  }

  /** "Try again" on a pending install: comes back to normal only once it's shown gone. */
  async function retryPending(): Promise<AppUpdateState> {
    await pendingOperation(async (budget) => {
      if ((await budget.observe(disarmPending))?.value !== true || disposed) return "held";
      if (pendingHold === "fenced") {
        options.disarmQuit();
        let problem: string | undefined;
        try {
          problem = await options.recover();
        } catch (error) {
          problem = oneLine(error);
        }
        if (problem) log("warn", `update: after a cleared pending install: ${problem}`);
      }
      pendingHold = undefined;
      apply({ type: "pendingCleared" });
      return "clear";
    });
    return state;
  }

  async function download(): Promise<AppUpdateState> {
    await start();
    if (disposed || pendingHold) return state;
    const version = state.availableVersion;
    const channel = state.channel;
    const before = state;
    if (apply({ type: "downloadStarted" }) === before || version === null) return state;
    await forget();
    try {
      const file = await port.download((percent) => apply({ type: "downloadProgress", percent }));
      const snapshot = await options.verifyDownload(file, version, channel);
      if (disposed) {
        await snapshot.close();
        return state;
      }
      verified = { version, snapshot };
      log("info", `update: ${version} downloaded and verified`);
      return apply({ type: "downloaded", version });
    } catch (error) {
      log(
        "warn",
        `update: download failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      return apply({ type: "downloadFailed", message: oneLine(error) });
    }
  }

  const CANCELLED = "Gram was asked to quit; the update was cancelled.";

  async function install(version: string): Promise<AppUpdateState> {
    await start();
    if (disposed || pendingHold) return state;
    if (state.downloadedVersion !== version) return state;
    const before = state;
    if (apply({ type: "installStarted" }) === before) return state;
    const refuse = async (
      message: string,
      { recover = false, step }: { recover?: boolean; step?: "check" | "download" } = {},
    ): Promise<AppUpdateState> => {
      if (step === "download" || step === "check") await forget();
      let problem: string | undefined;
      if (recover) {
        try {
          problem = await options.recover();
        } catch (error) {
          problem = oneLine(error);
        }
      }
      await options.record.remove().catch(() => {});
      return apply({
        type: "installRefused",
        message: problem ? `${message} ${problem}` : message,
        ...(step ? { step } : {}),
      });
    };
    if (!state.canInstall)
      return refuse(
        "Gram can only update itself from Applications. Move it there, then try again.",
      );
    const prefs = await options.readPrefs().catch(() => undefined);
    if (!prefs) return refuse("Gram couldn't read its update settings. Try again.");
    if (prefs.channel !== state.channel)
      return refuse("The release channel changed. Check for updates again.", { step: "check" });
    const candidate = verified;
    if (candidate?.version !== version)
      return refuse("The download isn't verified. Download it again.", { step: "download" });
    // The snapshot's private copy must still be its own file; what Squirrel.Mac is served is the
    // snapshot's descriptor, digest-checked as it streams.
    if (!(await candidate.snapshot.intact())) {
      return refuse("The download changed since it was verified. Download it again.", {
        step: "download",
      });
    }
    // Nothing of an earlier attempt may still be armed in macOS when this one starts; one that
    // can't be removed holds Gram as an update would, rather than leaving an unfenced exit.
    if ((await settlePending()) === "held") return state;

    let invoked = false;
    let staged = false;
    let stopped = false;
    let showWindows: (() => void) | undefined;
    const show = () => {
      showWindows?.();
      showWindows = undefined;
    };
    try {
      await options.transaction(async (signal) => {
        const live = () => {
          if (signal.aborted) throw new Error(CANCELLED);
        };
        showWindows = options.hideWindows();
        stopped = true;
        await options.stopForUpdate(signal);
        live();
        await options.record.write({
          schema: 1,
          from: options.currentVersion,
          to: version,
          at: now(),
        });
        live();
        // From this call on, Squirrel.Mac may arm an install at any moment: its outcome is
        // joined, never raced, and a quit asked for meanwhile no longer cancels anything.
        invoked = true;
        staging = true;
        const stage = port
          .stage(candidate.snapshot, version)
          .then(async () => {
            // Squirrel.Mac now owns its own copy. Release ours before the restart.
            await forget();
          })
          .finally(async () => {
            staging = false;
            if (disposed) await forget();
          });
        let waiting: unknown;
        const slow = new Promise<"slow">((resolve) => {
          waiting = later(() => resolve("slow"), STAGE_DEADLINE_MS);
        });
        const first = await Promise.race([stage.then(() => "staged" as const), slow]).finally(() =>
          cancelLater(waiting),
        );
        if (first === "slow") {
          // The fence has stopped everything, so quitting is safe; bringing it back isn't yet.
          options.armQuit();
          apply({
            type: "installHeld",
            message:
              "macOS is still preparing the update. Gram waits for it; quitting now is safe.",
          });
          show();
          await stage;
        }
        staged = true;
      });
    } catch (error) {
      if (!staged) {
        log("warn", `update: restart refused: ${error instanceof Error ? error.message : error}`);
        if (invoked) {
          // Squirrel.Mac refused, but it may already have written its installer's request. Nothing
          // comes back, and the record stays, until macOS shows no install pending.
          if (!(await boundedDisarm())) {
            await forget();
            options.armQuit();
            show();
            return apply({
              type: "installHeld",
              message:
                "macOS may still install this update when Gram quits, so Gram stays stopped. Quit Gram to finish.",
            });
          }
        }
        const reason =
          error instanceof UpdateTeardownRefused
            ? `Didn't restart: ${FENCE_REASON[error.teardown.reason]}. Nothing was installed.`
            : `Didn't restart: ${sentence(oneLine(error))} Nothing was installed.`;
        // Nothing is pending (or Squirrel.Mac was never invoked): quits are ordinary again.
        options.disarmQuit();
        const result = await refuse(reason, { recover: stopped });
        show();
        return result;
      }
    }
    // Squirrel.Mac has verified and staged the update: an exit now installs it. Quit into it, and
    // if the relaunch never comes, exit anyway so its installer runs; the next launch's record
    // tells whether it applied.
    log("info", `update: restarting into ${version}`);
    options.armQuit();
    later(() => {
      log("warn", "update: Squirrel.Mac didn't quit; exiting so its installer can run");
      options.exit();
    }, QUIT_DEADLINE_MS);
    try {
      port.quitAndInstall();
    } catch (error) {
      log("warn", `update: quitAndInstall threw: ${oneLine(error)}; exiting`);
      options.exit();
    }
    return state;
  }

  function start(): Promise<void> {
    launch ??= launchOnce();
    return launch;
  }

  async function launchOnce(): Promise<void> {
    const prefs = await options.readPrefs().catch(() => ({ channel: "stable" as const }));
    state = { ...state, channel: prefs.channel };
    const record = await options.record.read().catch(() => undefined);
    if (record) {
      const verdict = options.judge(record);
      if (verdict.kind === "notApplied") {
        log("warn", `update: ${verdict.version} was not applied; still ${options.currentVersion}`);
        apply({ type: "notApplied", version: verdict.version, reason: verdict.reason });
      } else if (verdict.kind === "applied") {
        log("info", `update: now running ${options.currentVersion}, as the restart asked`);
      }
      await options.record.remove().catch(() => {});
    }
    options.broadcast(state);
    // An install macOS may still have pending from before this launch is settled first.
    await settlePending();
    launchSettled = true;
    if (!options.timersAllowed || disposed) return;
    const tick = async () => {
      const current = await options.readPrefs().catch(() => undefined);
      if (current?.automaticChecks !== true || !backgroundCheckAllowed(state)) return;
      await check(current.channel, false);
    };
    later(() => void tick(), STARTUP_CHECK_DELAY_MS);
    every(() => void tick(), CHECK_INTERVAL_MS);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    // A native attempt still reading owns the snapshot until its actual outcome. Never revoke
    // that descriptor under Squirrel.Mac; a crash/exit leftover is reclaimed by the startup sweep.
    if (!staging) await forget();
  }

  return {
    state: () => state,
    start,
    check,
    download,
    install,
    async dismiss() {
      await start();
      if (disposed) return state;
      return pendingHold ? retryPending() : apply({ type: "dismissed" });
    },
    quitNeedsFence: () =>
      !launchSettled || pendingFlight !== undefined || pendingHold === "running",
    quitThroughFence() {
      quitFlight ??= (async () => {
        await start();
        await pendingFlight;
        if (pendingHold === "running") {
          await pendingOperation(async () => {
            await holdForPending();
            return "held";
          });
        }
        if (quitsFreely()) {
          await dispose();
          options.exit();
        } else if (!pendingHold) options.ordinaryQuit();
      })().finally(() => {
        quitFlight = undefined;
      });
      return quitFlight;
    },
    dispose,
  };
}
