import * as Schema from "effect/Schema";
import { inline } from "./agent-text.ts";

/** Where a repository keeps its verify recipe, relative to its folder. */
export const VERIFY_FILE = ".gram/verify.json";

/** The most drivers one recipe names. */
export const VERIFY_DRIVERS_MAX = 30;
/** The longest command, in characters. */
export const VERIFY_COMMAND_MAX = 2_000;
/** The most path patterns one driver names. */
export const VERIFY_COVERS_MAX = 40;
/** The longest a driver may run, in minutes, and what one runs for when it says nothing. */
export const VERIFY_TIMEOUT_MAX_MINUTES = 120;
export const VERIFY_TIMEOUT_DEFAULT_MINUTES = 30;

/** What a driver checks, for reading the recipe at a glance; it changes nothing about the run. */
export const VerifyDriverKind = Schema.Literals([
  "unit",
  "types",
  "lint",
  "e2e",
  "shots",
  "flow",
  "other",
]);
export type VerifyDriverKind = typeof VerifyDriverKind.Type;

export const VerifyDriver = Schema.Struct({
  name: Schema.String,
  /** One shell line, run in a clean checkout of the commit being verified. */
  run: Schema.String,
  /** Path patterns of the changes it covers (`apps/web/**`); absent, it covers every change. */
  covers: Schema.optionalKey(Schema.Array(Schema.String)),
  kind: Schema.optionalKey(VerifyDriverKind),
  /**
   * The repository asks that a worker pass it before reporting done. Gram says so to the worker
   * and shows it; it refuses nothing.
   */
  required: Schema.optionalKey(Schema.Boolean),
  timeoutMinutes: Schema.optionalKey(Schema.Int),
});
export type VerifyDriver = typeof VerifyDriver.Type;

const NAME = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const CONTROL = /[\p{Cc}؜​-‏‪-‮⁠⁦-⁩﻿]/u;
const KINDS: ReadonlySet<string> = new Set(VerifyDriverKind.literals);

const patternProblem = (pattern: string): string | undefined => {
  if (pattern === "" || pattern.trim() !== pattern)
    return "a pattern is empty or has spaces around it";
  if (pattern.startsWith("/") || pattern.startsWith("~") || /^[a-z]:/i.test(pattern))
    return `"${pattern}" must be relative to the repository`;
  if (pattern.split("/").includes("..")) return `"${pattern}" must stay inside the repository`;
  if (CONTROL.test(pattern)) return `"${pattern}" has a control character in it`;
  if (pattern.length > 200) return "keep each pattern under 200 characters";
  return undefined;
};

/** The drivers in a recipe file's text, or why it can't be read. */
export const parseVerifyRecipe = (
  text: string,
): { drivers: VerifyDriver[] } | { error: string } => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${VERIFY_FILE} isn't valid JSON.` };
  }
  const entries = (raw as { drivers?: unknown } | null)?.drivers;
  if (!Array.isArray(entries)) return { error: `${VERIFY_FILE} has no "drivers" list.` };
  if (entries.length > VERIFY_DRIVERS_MAX)
    return { error: `${VERIFY_FILE}: keep at most ${VERIFY_DRIVERS_MAX} drivers.` };
  const drivers: VerifyDriver[] = [];
  for (const [index, entry] of entries.entries()) {
    const at = `${VERIFY_FILE} driver ${index + 1}`;
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const { name, run, covers, kind, required, timeoutMinutes } = e;
    if (typeof name !== "string" || typeof run !== "string")
      return { error: `${at} needs a "name" and a "run" command.` };
    if (!NAME.test(name))
      return {
        error: `${at}: name it with up to 48 lowercase letters, digits and . _ -, such as "unit".`,
      };
    if (drivers.some((driver) => driver.name === name))
      return { error: `${at}: there is already a driver named ${name}.` };
    const command = run.trim();
    if (command === "") return { error: `${at} (${name}): give the command to run.` };
    if (command.length > VERIFY_COMMAND_MAX)
      return {
        error: `${at} (${name}): keep the command under ${VERIFY_COMMAND_MAX} characters; put longer ones in a script file.`,
      };
    if (CONTROL.test(command))
      return {
        error: `${at} (${name}): keep the command on one line, without control characters.`,
      };
    if (covers !== undefined) {
      if (!Array.isArray(covers) || covers.some((pattern) => typeof pattern !== "string"))
        return { error: `${at} (${name}): "covers" is a list of path patterns.` };
      if (covers.length > VERIFY_COVERS_MAX)
        return { error: `${at} (${name}): keep "covers" to ${VERIFY_COVERS_MAX} patterns.` };
      for (const pattern of covers as string[]) {
        const problem = patternProblem(pattern);
        if (problem !== undefined) return { error: `${at} (${name}): ${problem}.` };
      }
    }
    if (kind !== undefined && (typeof kind !== "string" || !KINDS.has(kind)))
      return {
        error: `${at} (${name}): "kind" is one of ${[...KINDS].join(", ")}.`,
      };
    if (required !== undefined && typeof required !== "boolean")
      return { error: `${at} (${name}): "required" is true or false.` };
    if (
      timeoutMinutes !== undefined &&
      (typeof timeoutMinutes !== "number" ||
        !Number.isInteger(timeoutMinutes) ||
        timeoutMinutes < 1 ||
        timeoutMinutes > VERIFY_TIMEOUT_MAX_MINUTES)
    )
      return {
        error: `${at} (${name}): "timeoutMinutes" is a whole number from 1 to ${VERIFY_TIMEOUT_MAX_MINUTES}.`,
      };
    drivers.push({
      name,
      run: command,
      ...(covers === undefined ? {} : { covers: covers as string[] }),
      ...(kind === undefined ? {} : { kind: kind as VerifyDriverKind }),
      ...(required === undefined ? {} : { required }),
      ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
    });
  }
  return { drivers };
};

/**
 * Whether `path` (relative, `/`-separated) matches `pattern`: `*` matches within one folder name,
 * `**` across folders, and a pattern ending in `/` matches everything under that folder.
 */
export const pathMatches = (pattern: string, path: string): boolean => {
  const wanted = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let source = "";
  for (let i = 0; i < wanted.length; i++) {
    const char = wanted[i]!;
    if (char === "*" && wanted[i + 1] === "*") {
      if (wanted[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(path);
};

/**
 * The drivers whose `covers` match any of `paths`, in the recipe's order. A driver without
 * `covers` covers every change; no paths (nothing changed yet) covers nothing.
 */
export const driversCovering = (
  drivers: readonly VerifyDriver[],
  paths: readonly string[],
): VerifyDriver[] =>
  paths.length === 0
    ? []
    : drivers.filter(
        (driver) =>
          driver.covers === undefined ||
          driver.covers.some((pattern) => paths.some((path) => pathMatches(pattern, path))),
      );

/** The required verify drivers on a worker's head, as Gram recorded their runs. */
export const WorkerReportVerify = Schema.Struct({
  head: Schema.String,
  passed: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
});
export type WorkerReportVerify = typeof WorkerReportVerify.Type;

const driverNames = (names: ReadonlyArray<string>): string =>
  names.map((name) => inline(name)).join(", ");

/** A report's verify record as its orchestrator reads it: Gram's word, never the worker's. */
export const verifyReportLine = (verify: WorkerReportVerify): string => {
  const parts = [
    ...(verify.passed.length === 0 ? [] : [`passed ${driverNames(verify.passed)}`]),
    ...(verify.missing.length === 0
      ? []
      : [`no pass yet on required ${driverNames(verify.missing)}`]),
  ];
  return `verify (recorded by Gram on ${verify.head.slice(0, 7)}, not the worker's word): ${parts.join("; ")}`;
};

/** How Gram recorded a driver's run on a thread's committed head. */
export const VerifyRunStatus = Schema.Literals(["notRun", "running", "passed", "failed"]);
export type VerifyRunStatus = typeof VerifyRunStatus.Type;

/** The folder Gram gives each verify run, empty, outside the checkout, for what it shows. */
export const VERIFY_EVIDENCE_ENV = "GRAM_VERIFY_EVIDENCE_DIR";
/** The optional list a driver writes into that folder: `{"items": [{file, caption, kind}]}`. */
export const VERIFY_EVIDENCE_MANIFEST = "manifest.json";
/** The most items a run's evidence shows. */
export const VERIFY_EVIDENCE_MAX_ITEMS = 24;
/** The most of one evidence file the Proof tab reads. */
export const VERIFY_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export const VerifyEvidenceKind = Schema.Literals(["screenshot", "video", "snapshot", "log"]);
export type VerifyEvidenceKind = typeof VerifyEvidenceKind.Type;

/** One file a driver left in its evidence folder, by its name there. */
export const VerifyEvidence = Schema.Struct({
  file: Schema.String,
  kind: VerifyEvidenceKind,
  caption: Schema.optionalKey(Schema.String),
  /** Bytes on disk. */
  size: Schema.Int,
});
export type VerifyEvidence = typeof VerifyEvidence.Type;

/** One driver of a thread's recipe, with how it ran on the thread's head. */
export const VerifyDriverState = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  kind: Schema.optionalKey(VerifyDriverKind),
  required: Schema.optionalKey(Schema.Boolean),
  /** Whether its `covers` match what the branch changed; absent where that can't be read. */
  coversChange: Schema.optionalKey(Schema.Boolean),
  status: VerifyRunStatus,
  /** Why it failed, in Gram's words. */
  reason: Schema.optionalKey(Schema.String),
  /** Epoch ms the run started and, once it ended, finished. */
  startedAt: Schema.optionalKey(Schema.Number),
  finishedAt: Schema.optionalKey(Schema.Number),
  /** What the run left in its evidence folder: the driver's own pictures, never a check's word. */
  evidence: Schema.optionalKey(Schema.Array(VerifyEvidence)),
});
export type VerifyDriverState = typeof VerifyDriverState.Type;

/**
 * A thread's verify recipe and Gram's record of each driver on its head: `none` without a recipe,
 * `unreadable` with one that can't be read (`error` says why), else `ok` with the drivers.
 */
export const VerifyState = Schema.Struct({
  recipe: Schema.Literals(["none", "unreadable", "ok"]),
  error: Schema.optionalKey(Schema.String),
  head: Schema.optionalKey(Schema.String),
  /** Changed files not committed, which no run includes. */
  uncommitted: Schema.optionalKey(Schema.Int),
  drivers: Schema.Array(VerifyDriverState),
});
export type VerifyState = typeof VerifyState.Type;
