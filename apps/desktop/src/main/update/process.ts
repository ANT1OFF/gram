import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

import { childEnv, PathProbe, PathProbeLive } from "@gram/git/proc";
import * as Effect from "effect/Effect";

import { authenticodeScript, type ProcessResult } from "@gram/shell/modules/update";

let loginPath: Promise<string> | undefined;

/** The login-shell PATH, probed once: the same probe the server's launch checks use. */
const probedPath = () =>
  (loginPath ??= Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PathProbe).path;
    }).pipe(Effect.provide(PathProbeLive)),
  ));

/**
 * `gh`'s environment. A GUI-launched app inherits launchd's minimal PATH, so `gh` runs on the
 * login-shell PATH instead, wherever it's installed; Windows keeps the inherited PATH.
 */
export function ghEnv(
  base: NodeJS.ProcessEnv,
  path: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return { ...childEnv(base, path, platform), GH_PROMPT_DISABLED: "1" };
}

function runProcess(
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    maxDownloadBytes?: number;
    downloadFile?: string;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let boundsTimer: ReturnType<typeof setInterval> | undefined;
    let oversized = false;
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        clearInterval(boundsTimer);
        if (oversized)
          return resolve({
            status: null,
            stdout: "",
            stderr: "Update download exceeded its byte bound",
          });
        if (!error) return resolve({ status: 0, stdout, stderr });
        // A numeric code is the exit status; otherwise it didn't start (ENOENT) or was killed.
        const status = typeof error.code === "number" ? error.code : null;
        // Killed for its timeout, it says nothing itself; say so, so the failure can be explained.
        const timedOut = error.killed ? `timed out after ${options.timeoutMs / 1000} s` : "";
        resolve({
          status,
          stdout,
          stderr: [stderr || error.message, timedOut].filter(Boolean).join("\n"),
        });
      },
    );
    if (
      options.downloadFile &&
      basename(options.downloadFile) === options.downloadFile &&
      options.maxDownloadBytes
    ) {
      const downloadPath = join(options.cwd, options.downloadFile);
      boundsTimer = setInterval(() => {
        void lstat(downloadPath).then(
          (stat) => {
            if (!stat.isFile() || stat.size > options.maxDownloadBytes!) {
              oversized = true;
              child.kill();
            }
          },
          () => {},
        );
      }, 100);
    }
    child.stdin?.end();
  });
}

export async function runGh(
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxDownloadBytes?: number;
    readonly downloadFile?: string;
  },
): Promise<ProcessResult> {
  return runProcess("gh", args, { ...options, env: ghEnv(process.env, await probedPath()) });
}

/** Runs the Authenticode probe under Windows PowerShell 5.1. */
export function probeSignature(installer: string): Promise<ProcessResult> {
  // Launched from a pwsh 7 terminal, the inherited PSModulePath points at PowerShell 7's modules and
  // 5.1 then fails to load Microsoft.PowerShell.Security, refusing a valid installer. pwsh strips
  // it when it starts powershell.exe; do the same.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
  );
  return runProcess(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", authenticodeScript(installer)],
    { cwd: dirname(installer), timeoutMs: 60_000, env },
  );
}
