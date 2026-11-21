// The repository's own Antigravity customizations: hooks, MCP servers and plugins that `agy acp`
// loads from a work folder with no trust prompt, whatever `--gemini-dir` says.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The folder Antigravity reads a workspace's own customizations from. */
export const CUSTOMIZATIONS_FOLDER = ".agents";

/** What in that folder runs code: hooks, MCP servers and plugins. */
const RUNNABLE = ["hooks.json", "mcp_config.json", "plugins"].map((name) =>
  join(CUSTOMIZATIONS_FOLDER, name),
);

/** Why Gram won't start Antigravity, or take a turn, where a folder has its own customizations. */
export const CUSTOMIZATIONS_REFUSAL =
  "This folder has its own Antigravity hooks, MCP servers or plugins (.agents/…). Gram doesn't run a repository's agent customizations unasked: move them aside or use another agent for this folder.";

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** `dir` and each parent up to its repository's root (the nearest holding `.git`), else `dir` alone. */
const upToRepoRoot = (dir: string): ReadonlyArray<string> => {
  const chain: Array<string> = [];
  let at = dir;
  for (;;) {
    chain.push(at);
    const up = dirname(at);
    if (present(join(at, ".git"))) return chain;
    if (up === at) return [dir];
    at = up;
  }
};

/** `dir` as given and with every link followed, as agy may read either. */
const bothPaths = (dir: string): ReadonlyArray<string> => {
  const given = resolve(dir);
  try {
    return [given, realpathSync(given)];
  } catch {
    return [given];
  }
};

/** The runnable customizations Antigravity would load for a session in `dirs`. */
export const workspaceCustomizations = (dirs: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(dirs.flatMap(bothPaths).flatMap(upToRepoRoot))].flatMap((dir) =>
    RUNNABLE.map((path) => join(dir, path)).filter(present),
  );

/** `CUSTOMIZATIONS_REFUSAL` when `dirs` hold runnable customizations, naming them. */
export const refuseCustomizations = (dirs: ReadonlyArray<string>): string | undefined => {
  const found = workspaceCustomizations(dirs);
  return found.length === 0 ? undefined : `${CUSTOMIZATIONS_REFUSAL} Found: ${found.join(", ")}.`;
};
