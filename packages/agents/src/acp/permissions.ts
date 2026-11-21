// How Gram answers an ACP agent's permission requests: which option carries an answer, and which
// requests Gram answers itself without showing a card.

import type { ApprovalScope, PermissionMode } from "@gram/contracts";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { OutwardGate } from "../host.ts";
import { gateAsks, outwardKind } from "../outward.ts";
import { type Json, record, records, text } from "./json.ts";

/** The ACP option to pick for an answer, from the ones the request offered. */
export interface PermissionOption {
  readonly optionId: string;
  readonly kind: string;
}

/** The options a `session/request_permission` offers. */
export const offeredOptions = (params: Json): ReadonlyArray<PermissionOption> =>
  records(params["options"]).flatMap((option): Array<PermissionOption> => {
    const optionId = text(option["optionId"]);
    const kind = text(option["kind"]);
    return optionId === undefined || kind === undefined ? [] : [{ optionId, kind }];
  });

/** Gram's scope for an option: `allow_always` is session-long when its id says so. */
export const scopeOf = (option: PermissionOption): ApprovalScope | undefined => {
  if (option.kind === "allow_once") return "once";
  if (option.kind === "allow_always")
    return option.optionId.endsWith("-session") ? "session" : "always";
  return undefined;
};

/** The option that carries `decision` at `scope`, falling back to the narrowest allow. */
export const optionFor = (
  options: ReadonlyArray<PermissionOption>,
  decision: "allow" | "deny",
  scope: ApprovalScope | undefined,
): PermissionOption | undefined => {
  if (decision === "deny")
    return (
      options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind.startsWith("reject"))
    );
  return (
    options.find((option) => scope !== undefined && scopeOf(option) === scope) ??
    options.find((option) => option.kind === "allow_once")
  );
};

/** The input keys a coding agent names an edited path by. */
export const EDIT_PATH_KEYS = [
  "file_path",
  "target_file",
  "path",
  "notebook_path",
  "target_directory",
];

const exists = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Where a write to absolute `path` lands: its nearest existing ancestor with every link followed,
 * then the rest, which can hold no link. `undefined` for a path that is itself a link, dangling or
 * not, or whose links can't be followed.
 */
const landing = (path: string): string | undefined => {
  let at = path;
  while (exists(at) === undefined) {
    if (dirname(at) === at) return undefined;
    at = dirname(at);
  }
  if (at === path && exists(at)?.isSymbolicLink() === true) return undefined;
  try {
    return join(realpathSync(at), relative(at, path));
  } catch {
    return undefined;
  }
};

/**
 * Whether every path an edit request names (its `locations` and its input's `keys`) lands, once
 * links are followed, inside one of `roots`, the first of which relative paths are read from. A
 * request naming no path, or a path with a `..` step or ending in a link, is not.
 */
export const editWithin = (
  call: Json,
  roots: ReadonlyArray<string>,
  keys: ReadonlyArray<string> = EDIT_PATH_KEYS,
): boolean => {
  const [cwd] = roots;
  if (cwd === undefined) return false;
  const input = record(call["rawInput"]);
  const named = [
    ...records(call["locations"]).map((at) => at["path"]),
    ...keys.map((key) => input[key]),
  ].filter((path) => path !== undefined);
  if (named.length === 0) return false;
  const inside = roots.flatMap((root) => {
    try {
      return [realpathSync(resolve(root))];
    } catch {
      return [];
    }
  });
  return named.every((path) => {
    if (typeof path !== "string" || path === "" || path.split(/[\\/]/).includes("..")) return false;
    const real = landing(resolve(cwd, path));
    return (
      real !== undefined &&
      inside.some((root) => {
        const rest = relative(root, real);
        return rest === "" || (!rest.split(/[\\/]/).includes("..") && !isAbsolute(rest));
      })
    );
  });
};

/** What Gram reads from a permission request to answer it itself. */
export interface CallFacts {
  /** The call is one of Gram's own app tools, whose registry raises its own card. */
  readonly appTool: boolean;
  /** The command line of a call that runs one. */
  readonly command: string | undefined;
  /** The input keys the agent names an edited path by. */
  readonly editKeys?: ReadonlyArray<string>;
  /** The agent's own auto mode asks the person about what it won't run, so Gram shows that. */
  readonly autoAsks?: boolean;
}

/**
 * The answer Gram gives a permission request itself, without a card: Gram's own app tools go
 * through, as their registry raises its own card where one is needed; `dontAsk` refuses, edits
 * inside the thread's folders (`roots`, `editWithin`) go through in `acceptEdits`, and a mode that
 * would have run the call unasked lets it through when the outward gate doesn't ask about it.
 * `undefined` shows the card.
 */
export const answerItself = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  call: Json,
  roots: ReadonlyArray<string>,
  facts: CallFacts,
): "allow" | "deny" | undefined => {
  if (facts.appTool) return "allow";
  if (mode === "dontAsk") return "deny";
  const kind = text(call["kind"]);
  if (mode === "acceptEdits" && kind === "edit" && editWithin(call, roots, facts.editKeys))
    return "allow";
  if (mode !== "bypassPermissions" && mode !== "auto") return undefined;
  if (gate === undefined) return mode === "auto" && facts.autoAsks === true ? undefined : "allow";
  if (kind !== "execute") return "allow";
  if (facts.command === undefined) return undefined;
  return gateAsks(gate, outwardKind(facts.command)) ? undefined : "allow";
};
