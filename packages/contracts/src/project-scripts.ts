// Project scripts: a project's common commands (build, test, lint, dev), kept in
// `.gram/scripts.json` beside `.gram/launch.json` and run by the user, never by an agent, in a
// terminal tab named after the script. The parsers here are pure so the server, the mock and the
// tests read the file, `package.json` and a Makefile the same way.

import * as Schema from "effect/Schema";
import { ProjectId } from "./ids.ts";

/** Where a project keeps its scripts, relative to the project's folder. */
export const SCRIPTS_FILE = ".gram/scripts.json";

/** The most scripts one project keeps. */
export const SCRIPTS_MAX = 50;
/** The longest command, in characters. */
export const SCRIPT_COMMAND_MAX = 2_000;
/** The most suggestions offered at once. */
export const SUGGESTIONS_MAX = 30;

export const ProjectScript = Schema.Struct({
  name: Schema.String,
  /** One shell line, run by the user's shell in the thread's checkout (or `cwd` inside it). */
  command: Schema.String,
  /** A folder relative to the checkout. */
  cwd: Schema.optionalKey(Schema.String),
  /** Keys in the shortcut registry's form, e.g. `mod+alt+t`. */
  shortcut: Schema.optionalKey(Schema.String),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ScriptSource = Schema.Literals(["package.json", "Makefile"]);
export type ScriptSource = typeof ScriptSource.Type;

/** A command the project already names somewhere else, offered with an Add button. */
export const ScriptSuggestion = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  source: ScriptSource,
});
export type ScriptSuggestion = typeof ScriptSuggestion.Type;

/** `projects.scripts`: what the project's scripts file holds, and what could be added to it. */
export const ProjectScripts = Schema.Struct({
  projectId: ProjectId,
  /** The file, relative to the project's folder: `SCRIPTS_FILE`. */
  file: Schema.String,
  scripts: Schema.Array(ProjectScript),
  /** Commands from `package.json` and the Makefile not saved as scripts yet. */
  suggestions: Schema.Array(ScriptSuggestion),
  /** Why the file can't be read as scripts; `scripts` is empty then, and saving replaces it. */
  problem: Schema.optionalKey(Schema.String),
});
export type ProjectScripts = typeof ProjectScripts.Type;

export const SaveProjectScriptsPayload = Schema.Struct({
  projectId: ProjectId,
  scripts: Schema.Array(ProjectScript),
});
export type SaveProjectScriptsPayload = typeof SaveProjectScriptsPayload.Type;

const NAME = /^[\w .:/-]{1,64}$/;
/** Control and invisible formatting characters, which have no place in a one-line command. */
const CONTROL = /[\p{Cc}\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;
const MODIFIERS = ["mod", "ctrl", "alt", "shift"] as const;
const KEY = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/;

/**
 * `keys` in the registry's canonical order (`mod+ctrl+alt+shift+key`), or why it can't be a
 * script's shortcut: it needs ⌘/Ctrl or ⌥ with a letter or digit, or a function key, so typing never
 * runs a script.
 */
export const normalizeShortcut = (keys: string): { keys: string } | { error: string } => {
  const parts = keys.trim().toLowerCase().split("+");
  const key = parts.pop() ?? "";
  if (!KEY.test(key)) return { error: "A shortcut ends in a letter, a digit or F1 to F12." };
  if (parts.some((part) => !(MODIFIERS as readonly string[]).includes(part)))
    return { error: "A shortcut's modifiers are mod, ctrl, alt and shift." };
  const held = MODIFIERS.filter((modifier) => parts.includes(modifier));
  if (!key.startsWith("f") || key.length === 1) {
    if (!held.includes("mod") && !held.includes("ctrl") && !held.includes("alt"))
      return { error: "Hold ⌘, Ctrl or ⌥ with the key, so typing never runs the script." };
  }
  return { keys: [...held, key].join("+") };
};

/** Why `cwd` can't be a script's folder, or `undefined`: it stays inside the checkout. */
export const scriptFolderProblem = (cwd: string): string | undefined => {
  if (cwd.trim() !== cwd || cwd === "") return "Give the folder without spaces around it.";
  if (/^([a-z]:)?[\\/]/i.test(cwd) || cwd.startsWith("~"))
    return "Give the folder relative to the project, such as apps/web.";
  if (cwd.split(/[\\/]/).includes("..")) return "The folder must stay inside the project.";
  if (CONTROL.test(cwd)) return "The folder has a control character in it.";
  return undefined;
};

/** Why `script` can't be kept beside `others`, or `undefined`. */
export const scriptProblem = (
  script: ProjectScript,
  others: readonly ProjectScript[],
): string | undefined => {
  if (!NAME.test(script.name) || script.name.trim() !== script.name)
    return "Name it with up to 64 letters, digits, spaces and . : / _ -.";
  if (others.some((other) => other.name.toLowerCase() === script.name.toLowerCase()))
    return `There is already a script named ${script.name}.`;
  if (script.command.trim() === "") return "Give the command to run.";
  if (script.command.length > SCRIPT_COMMAND_MAX)
    return `Keep the command under ${SCRIPT_COMMAND_MAX} characters; put longer ones in a script file.`;
  if (CONTROL.test(script.command))
    return "Keep the command on one line, without control characters.";
  if (script.cwd !== undefined) {
    const problem = scriptFolderProblem(script.cwd);
    if (problem !== undefined) return problem;
  }
  if (script.shortcut !== undefined) {
    const shortcut = normalizeShortcut(script.shortcut);
    if ("error" in shortcut) return shortcut.error;
    const taken = others.find(
      (other) =>
        other.shortcut !== undefined &&
        "keys" in normalizeShortcut(other.shortcut) &&
        (normalizeShortcut(other.shortcut) as { keys: string }).keys === shortcut.keys,
    );
    if (taken !== undefined) return `${taken.name} already uses that shortcut.`;
  }
  return undefined;
};

/** `scripts` trimmed and checked together, or the first one's problem. */
export const validateScripts = (
  scripts: readonly ProjectScript[],
): { scripts: ProjectScript[] } | { error: string } => {
  if (scripts.length > SCRIPTS_MAX) return { error: `Keep at most ${SCRIPTS_MAX} scripts.` };
  const kept: ProjectScript[] = [];
  for (const script of scripts) {
    const cwd = script.cwd?.trim();
    const shortcut = script.shortcut?.trim();
    const tidy: ProjectScript = {
      name: script.name.trim(),
      command: script.command.trim(),
      ...(cwd === undefined || cwd === "" || cwd === "." ? {} : { cwd }),
      ...(shortcut === undefined || shortcut === "" ? {} : { shortcut }),
    };
    const problem = scriptProblem(tidy, kept);
    if (problem !== undefined) return { error: `${tidy.name || "A script"}: ${problem}` };
    const keys = tidy.shortcut === undefined ? undefined : normalizeShortcut(tidy.shortcut);
    kept.push(keys !== undefined && "keys" in keys ? { ...tidy, shortcut: keys.keys } : tidy);
  }
  return { scripts: kept };
};

/** The scripts in a scripts file's text, or why it can't be read. */
export const parseScriptsFile = (
  text: string,
): { scripts: ProjectScript[] } | { error: string } => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${SCRIPTS_FILE} isn't valid JSON.` };
  }
  const entries = (raw as { scripts?: unknown } | null)?.scripts;
  if (!Array.isArray(entries)) return { error: `${SCRIPTS_FILE} has no "scripts" list.` };
  const scripts: ProjectScript[] = [];
  for (const [index, entry] of entries.entries()) {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const { name, command, cwd, shortcut } = e;
    if (typeof name !== "string" || typeof command !== "string")
      return { error: `${SCRIPTS_FILE} script ${index + 1} needs a "name" and a "command".` };
    if (cwd !== undefined && typeof cwd !== "string")
      return { error: `${SCRIPTS_FILE} script ${index + 1}: "cwd" must be a folder name.` };
    if (shortcut !== undefined && typeof shortcut !== "string")
      return {
        error: `${SCRIPTS_FILE} script ${index + 1}: "shortcut" must be keys like mod+alt+t.`,
      };
    scripts.push({
      name,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(shortcut === undefined ? {} : { shortcut }),
    });
  }
  const checked = validateScripts(scripts);
  return "error" in checked ? { error: `${SCRIPTS_FILE}: ${checked.error}` } : checked;
};

/** The scripts file's text for `scripts`: two-space JSON a person can edit, ending in a newline. */
export const scriptsFileText = (scripts: readonly ProjectScript[]): string =>
  `${JSON.stringify({ scripts }, null, 2)}\n`;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** The lockfiles `packageManagerOf` looks for beside `package.json`. */
export const LOCKFILE_NAMES: readonly string[] = LOCKFILES.map(([file]) => file);

/** The package manager `package.json`'s `packageManager` names, else its lockfile's, else npm. */
export const packageManagerOf = (
  pkg: { readonly packageManager?: unknown },
  files: readonly string[],
): PackageManager => {
  const named = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (named === "npm" || named === "pnpm" || named === "yarn" || named === "bun") return named;
  return LOCKFILES.find(([file]) => files.includes(file))?.[1] ?? "npm";
};

/** Lifecycle scripts a package manager runs on its own, which nobody runs by hand. */
const LIFECYCLE = new Set([
  "install",
  "preinstall",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "dependencies",
]);
/** The commands people run most, offered first. */
const COMMON = ["dev", "start", "build", "test", "lint", "typecheck", "check", "format"];
const SCRIPT_KEY = /^[\w:.@/-]{1,64}$/;

const commonRank = (name: string) => {
  const index = COMMON.indexOf(name);
  return index === -1 ? COMMON.length : index;
};

const byCommonFirst = (names: readonly string[]) =>
  names.toSorted((a, b) => commonRank(a) - commonRank(b));

/** `package.json`'s scripts as `<manager> run <name>` commands, hooks and lifecycle left out. */
export const packageJsonSuggestions = (
  text: string,
  files: readonly string[] = [],
): ScriptSuggestion[] => {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof pkg !== "object" || pkg === null) return [];
  const scripts = (pkg as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];
  const names = Object.entries(scripts)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([name]) => name);
  const manager = packageManagerOf(pkg as { packageManager?: unknown }, files);
  const kept = names.filter((name) => {
    if (!SCRIPT_KEY.test(name) || LIFECYCLE.has(name)) return false;
    // `pretest` and `posttest` run with `test`.
    const hooked = /^(pre|post)(.+)$/.exec(name)?.[2];
    return hooked === undefined || !names.includes(hooked);
  });
  return byCommonFirst(kept).map((name) => ({
    name: name.slice(0, 64),
    command: `${manager} run ${name}`,
    source: "package.json",
  }));
};

/**
 * A Makefile's targets that someone would run by name: not special (`.PHONY`), pattern (`%.o`) or
 * variable-named targets, nor a variable assignment (`a := b`).
 */
export const makefileTargets = (text: string): string[] => {
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("\t") || line.startsWith(" ") || line.startsWith("#")) continue;
    const match = /^([^:=#]+?)\s*::?(?![:=])(.*)$/.exec(line);
    if (match === null) continue;
    // `a: b = c` is a target-specific variable, not a rule worth running.
    if (/^\s*[\w.-]+\s*[?+:!]?=/.test(match[2] ?? "")) continue;
    for (const target of match[1]!.trim().split(/\s+/)) {
      if (!/^[A-Za-z0-9][\w.-]*$/.test(target) || target.length > 64) continue;
      if (!targets.includes(target)) targets.push(target);
    }
  }
  return targets;
};

/** The Makefile's targets as `make <target>` commands, the common ones first. */
export const makefileSuggestions = (text: string): ScriptSuggestion[] =>
  byCommonFirst(makefileTargets(text)).map((target) => ({
    name: target,
    command: `make ${target}`,
    source: "Makefile",
  }));

/**
 * What to offer beside `existing`: `package.json`'s scripts, then the Makefile's targets, each
 * once by name and by command, none already saved, at most `SUGGESTIONS_MAX`.
 */
export const scriptSuggestions = (
  sources: {
    readonly packageJson?: string | undefined;
    readonly makefile?: string | undefined;
    /** The file names beside `package.json`, for its package manager's lockfile. */
    readonly files?: readonly string[] | undefined;
  },
  existing: readonly ProjectScript[],
): ScriptSuggestion[] => {
  const all = [
    ...(sources.packageJson === undefined
      ? []
      : packageJsonSuggestions(sources.packageJson, sources.files)),
    ...(sources.makefile === undefined ? [] : makefileSuggestions(sources.makefile)),
  ];
  const names = new Set(existing.map((script) => script.name.toLowerCase()));
  const commands = new Set(existing.map((script) => script.command.trim()));
  const offered: ScriptSuggestion[] = [];
  for (const suggestion of all) {
    const name = suggestion.name.toLowerCase();
    if (names.has(name) || commands.has(suggestion.command)) continue;
    names.add(name);
    commands.add(suggestion.command);
    offered.push(suggestion);
    if (offered.length === SUGGESTIONS_MAX) break;
  }
  return offered;
};

/** What a script terminal's tab shows about its run. */
export type ScriptRunState = "running" | "finished" | "failed";

/** A finished run's state from how its process ended. */
export const scriptRunState = (exit: {
  readonly code?: number | undefined;
  readonly signal?: string | undefined;
}): ScriptRunState => (exit.code === 0 && exit.signal === undefined ? "finished" : "failed");
