import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type {
  UpdateChannel,
  UpdateCheck,
  UpdateInstallIntent,
  UpdateInstallResult,
  UpdateProgress,
} from "@gram/contracts";

import { UPDATE_MIN_FREE_BYTES, UPDATE_REPO } from "./config.ts";
import { isUpdateDirName } from "./sweep.ts";
import type { Updater } from "./updater.ts";

export interface UpdateServiceOptions {
  readonly updater: Updater;
  /** Stops the server gracefully, so sessions are flushed before the installer kills the app. */
  readonly stopServer: () => Promise<void>;
  /**
   * Starts the server again and reloads every window, after a failed launch; rejects if the server
   * doesn't boot, having told the user.
   */
  readonly restartServer: () => Promise<void>;
  readonly broadcast: (progress: UpdateProgress) => void;
  /** Hides every window and returns a function that shows them again. */
  readonly hideWindows: () => () => void;
  /** Exits the app so the installer can replace it. */
  readonly exit: () => void;
  /** Launches the verified installer detached; defaults to `spawnInstaller`. */
  readonly spawnInstaller?: (installer: string) => Promise<void>;
  /** How long the reply has to reach the renderer before `exit`; 250 ms by default. */
  readonly exitDelayMs?: number;
  /** Where a failed install is logged, with the error as it was thrown. */
  readonly warn?: ((message: string) => void) | undefined;
  /** The release page a failure points to for a manual install; GitHub's, for `UPDATE_REPO`. */
  readonly releasePage?: ((tag: string) => string | undefined) | undefined;
}

export interface UpdateService {
  check(channel: UpdateChannel): Promise<UpdateCheck>;
  install(intent: UpdateInstallIntent): Promise<UpdateInstallResult>;
}

// electron-builder's NSIS template reads only the flags `NsisTarget` declares, plus NSIS's own `/S`;
// these are what electron-updater's `NsisUpdater` passes. `--updated` gives the exiting app time
// to close instead of killing it, and is handed on to the relaunched app; `/S` is silent, which a
// per-user install can be without elevation; `--force-run` relaunches the app after a silent install.
export const NSIS_UPDATE_ARGS: readonly string[] = ["--updated", "/S", "--force-run"];

export function spawnInstaller(installer: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(installer, NSIS_UPDATE_ARGS, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const codeOf = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** `UPDATE_REPO`'s release page for `tag`, or undefined while there's no repo. */
export const githubReleasePage = (tag: string): string | undefined =>
  UPDATE_REPO === null ? undefined : `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`;

// What `gh` (Go) and Windows print for the same failures Node reports with a code: the desktop
// downloads through `gh release download`, whose failure reaches here as its stderr text alone.
const DISK_FULL = /ENOSPC|no space left on device|not enough space on the disk/i;
const TIMED_OUT = /timed out|deadline exceeded|Client\.Timeout/i;
const NETWORK =
  /net::ERR_[A-Z_]+|dial tcp|no such host|connection refused|connection reset|proxyconnect|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i;
const ACCESS_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const ACCESS = /Access is denied|being used by another process|virus/i;

/**
 * Why a download or launch failed, in words that say what to do, for an error that comes from the
 * machine or the network rather than the updater's own checks: those already say why, and pass
 * through. Read from the error's code and name where Node gives them, and from its text where the
 * failure came from `gh`. The second field is whether installing by hand is worth suggesting.
 */
export function explainUpdateFailure(error: unknown): { text: string; manual: boolean } {
  const code = codeOf(error);
  const text = message(error);
  const name = error instanceof Error ? error.name : "";
  if (code === "ENOSPC" || DISK_FULL.test(text)) {
    return {
      text:
        "The disk is full, so the installer couldn't be saved. Free at least " +
        `${UPDATE_MIN_FREE_BYTES / 1024 ** 3} GB and try again.`,
      manual: false,
    };
  }
  if (name === "TimeoutError" || name === "AbortError" || TIMED_OUT.test(text)) {
    return {
      text: "The download took too long and was stopped. Check the network connection and try again.",
      manual: true,
    };
  }
  // Undici's `fetch failed`, Electron's `net::ERR_*` and Go's dial errors are a connection that
  // never completed: offline, a proxy or Global Secure Access refusing it, or a reset mid-download.
  const fetchFailed = name === "TypeError" && text === "fetch failed";
  if (fetchFailed || NETWORK.test(text)) {
    const cause = codeOf(error instanceof Error ? error.cause : undefined);
    const detail = fetchFailed
      ? typeof cause === "string"
        ? cause
        : undefined
      : NETWORK.exec(text)?.[0];
    return {
      text:
        "Couldn't reach GitHub to download the installer" +
        `${detail === undefined ? "" : ` (${detail})`}. Check the network connection, VPN or ` +
        "proxy and try again.",
      manual: true,
    };
  }
  if ((typeof code === "string" && ACCESS_CODES.has(code)) || ACCESS.test(text)) {
    return {
      text:
        `The operating system refused the update file${typeof code === "string" ? ` (${code})` : ""}; ` +
        "another process or security software may be using it. Try again in a minute.",
      manual: true,
    };
  }
  if (/SHA-256|download stopped at|ran past its/.test(text)) {
    return { text: `${text}: the download was damaged on the way. Try again.`, manual: true };
  }
  return { text, manual: false };
}

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  const { updater, broadcast } = options;
  const launch = options.spawnInstaller ?? spawnInstaller;
  const releasePage = options.releasePage ?? githubReleasePage;
  // One install at a time: a duplicate request mid-teardown would launch a second installer over
  // the first one's still-flushing sessions. Cleared only on failure, so a retry can run.
  let applying = false;

  /**
   * Logs `cause` as thrown, and tells the renderer why in words, with the manual way when it helps.
   * `cause` goes to `explainUpdateFailure` as it was thrown, so its code survives.
   */
  const fail = (
    tag: string,
    cause: unknown,
    prefix = "",
    suffix = "",
    warn = true,
  ): UpdateInstallResult => {
    if (warn)
      options.warn?.(`update: installing ${tag} failed: ${prefix}${message(cause)}${suffix}`);
    const { text, manual } = explainUpdateFailure(cause);
    const page = manual ? releasePage(tag) : undefined;
    const error =
      prefix + text + suffix + (page === undefined ? "" : ` Or install it by hand from ${page}.`);
    broadcast({ stage: "failed", tag, error });
    return { updating: false, error };
  };

  async function install(requested: UpdateInstallIntent): Promise<UpdateInstallResult> {
    const { tag } = requested;
    if (!updater.canSelfInstall)
      return { updating: false, error: "This installation can't update itself." };
    if (applying) return { updating: false, error: "an install is already in progress" };
    applying = true;

    let installer: string;
    try {
      installer = await updater.downloadAndVerify(requested, broadcast);
    } catch (error) {
      applying = false;
      return fail(tag, error);
    }

    broadcast({ stage: "installing", tag });
    // The app should look gone at once rather than sit frozen while sessions flush.
    const showWindows = options.hideWindows();
    let launchingInstaller = false;
    try {
      await options.stopServer();
      launchingInstaller = true;
      await launch(installer);
    } catch (error) {
      // Publish the failure before restartServer initiates any window navigation.
      const failure = fail(
        tag,
        error,
        launchingInstaller ? "failed to launch installer: " : "",
        "",
        false,
      );
      // AV quarantine can still pull the verified file. Stay up rather than exit with nothing to
      // relaunch us: reclaim the dir, bring the server and windows back.
      const dir = dirname(installer);
      if (isUpdateDirName(basename(dir)))
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      let restartError = "";
      try {
        await options.restartServer();
      } catch (restart) {
        // `restartServer` has offered the user a way back; the windows still have to reappear.
        restartError = `; the server didn't restart: ${message(restart)}`;
      }
      showWindows();
      applying = false;
      if (!restartError) {
        options.warn?.(
          `update: installing ${tag} failed: ${launchingInstaller ? "failed to launch installer: " : ""}${message(error)}`,
        );
        return failure;
      }
      return fail(
        tag,
        error,
        launchingInstaller ? "failed to launch installer: " : "",
        restartError,
      );
    }

    // Let the reply reach the renderer, then get out of the installer's way.
    setTimeout(options.exit, options.exitDelayMs ?? 250);
    return { updating: true };
  }

  return { check: (channel) => updater.check(channel), install };
}
