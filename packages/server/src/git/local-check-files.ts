import type { HostCheckResult } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { closeSync, constants, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { diagnoseExit, lastLines, type LocalCheckOutcome } from "./check-process.ts";

/** A file's size and when it last changed, or undefined when it isn't a regular file. */
export const fileStat = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
};

/** A folder's stat, links not followed, or undefined when it isn't a folder. */
export const dirStat = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? stat : undefined;
  } catch {
    return undefined;
  }
};

/** The names in `dir`, or none when it can't be read. */
export const entries = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Keeps failure reasons when a local check has no command output or could not start. */
export const logLocalFailure = (log: string | undefined, outcome: LocalCheckOutcome) => {
  if (log === undefined || outcome.ok || outcome.reason === undefined) return Effect.void;
  const reason = lastLines(outcome.reason);
  return Effect.try({
    try: () => {
      const size = fileStat(log)?.size ?? 0;
      if (size > 0 && outcome.failure?.kind !== "unstartable") return;
      const fd = openSync(
        log,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
      try {
        writeFileSync(fd, `${size === 0 ? "" : "\n"}${reason}\n`);
      } finally {
        closeSync(fd);
      }
    },
    catch: () => undefined,
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("local check: couldn't record its failure in the check log").pipe(
        Effect.annotateLogs({ reason }),
      ),
    ),
  );
};

/** Gives a silent exit from an older host a diagnostic. */
export const withHostCheckDiagnostic = (result: HostCheckResult): HostCheckResult => {
  if (
    !result.ok &&
    (result.log?.trim() ?? "") === "" &&
    result.failure?.kind === "exited" &&
    result.failure.exitCode !== undefined &&
    result.reason === `exited ${result.failure.exitCode}`
  )
    return {
      ...result,
      reason: diagnoseExit(result.failure.exitCode, null, "", "").reason ?? result.reason,
    };
  return result;
};

/** Saves the output or failure reason returned by a joined host. */
export const logHostCheck = (log: string | undefined, result: HostCheckResult) =>
  Effect.sync(() => {
    if (log === undefined) return;
    const text = (result.log?.trim() ? result.log : result.reason) ?? "";
    try {
      writeFileSync(log, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    } catch (_theRecordKeepsHowItEndedRegardless) {}
  });
