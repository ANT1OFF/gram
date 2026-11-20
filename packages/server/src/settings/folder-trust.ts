// What a folder brings that would load as the user once they trust it: the question Gram asks,
// once, when a folder is added. Reading it runs nothing; every file is read inside the folder,
// never through a link that leaves it.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { type FolderSettings, type Project, parseScriptsFile, SCRIPTS_FILE } from "@gram/contracts";
import { readInside, realRoot } from "@gram/git";

/** The files whose contents would load as the user's: Claude's project and local settings, MCP. */
const CLAUDE_SETTINGS = [".claude/settings.json", ".claude/settings.local.json"] as const;
const MCP_FILE = ".mcp.json";

/** Settings keys that name a command Claude Code runs. */
const COMMAND_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "statusLine"];

/** The settings keys read above, and those known to load nothing that runs or widens access. */
const READ_KEYS = new Set(["hooks", "permissions", "env", "mcpServers", ...COMMAND_KEYS]);
const HARMLESS_KEYS = new Set([
  "$schema",
  "model",
  "includeCoAuthoredBy",
  "attribution",
  "outputStyle",
  "alwaysThinkingEnabled",
  "language",
]);
/** Permission keys that only narrow what runs; `allow` is counted, and any other key is other. */
const NARROWING_PERMISSIONS = new Set(["allow", "deny", "ask"]);

/** Claude Code's definitions under `.claude`, whose frontmatter can carry hooks and tools. */
const DEFINITION_DIRS = ["agents", "skills", "commands", "output-styles"];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The file's text; `undefined` when it isn't there, `null` when it is but can't be read. */
const read = (root: string, rel: string): string | undefined | null => {
  try {
    return readInside(root, rel);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
};

const parse = (text: string): Json | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const lstat = (path: string) => {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/**
 * The agent, skill, command and output-style folders under `.claude` that hold anything, or
 * `.claude` itself when it is a link or can't be looked in: Claude Code loads each as the user's.
 */
const definitions = (real: string): ReadonlyArray<string> => {
  try {
    const claude = lstat(nodePath.join(real, ".claude"));
    if (claude === undefined || claude.isFile()) return [];
    if (!claude.isDirectory()) return [".claude"];
    return DEFINITION_DIRS.flatMap((name) => {
      const path = nodePath.join(real, ".claude", name);
      const found = lstat(path);
      if (found === undefined) return [];
      return found.isDirectory() && fs.readdirSync(path).length === 0 ? [] : [`.claude/${name}`];
    });
  } catch {
    return [".claude"];
  }
};

/** `FolderSettings` for the folder at `root`. Throws when the folder itself can't be resolved. */
export const folderSettings = (root: string): FolderSettings => {
  const real = realRoot(root);
  const hooks: Array<{ event: string; command: string }> = [];
  const mcpServers = new Set<string>();
  const env = new Set<string>();
  const commands: Array<string> = [];
  const unreadable: Array<string> = [];
  const other: Array<string> = [];
  let allowRules = 0;

  const load = (rel: string): Json | undefined => {
    const text = read(real, rel);
    if (text === undefined) return undefined;
    const parsed = text === null ? undefined : parse(text);
    // A file Claude Code would still try to load counts, so it is asked about rather than missed.
    if (parsed === undefined) unreadable.push(rel);
    return parsed;
  };

  for (const rel of CLAUDE_SETTINGS) {
    const settings = load(rel);
    if (settings === undefined) continue;
    if (isObject(settings["hooks"])) {
      for (const [event, groups] of Object.entries(settings["hooks"])) {
        for (const group of Array.isArray(groups) ? groups : []) {
          const inner = isObject(group) && Array.isArray(group["hooks"]) ? group["hooks"] : [];
          for (const hook of inner) {
            const command = isObject(hook) ? hook["command"] : undefined;
            hooks.push({ event, command: typeof command === "string" ? command : "" });
          }
        }
      }
    }
    const permissions = isObject(settings["permissions"]) ? settings["permissions"] : {};
    if (Array.isArray(permissions["allow"])) allowRules += permissions["allow"].length;
    if (isObject(settings["env"])) for (const name of Object.keys(settings["env"])) env.add(name);
    if (isObject(settings["mcpServers"]))
      for (const name of Object.keys(settings["mcpServers"])) mcpServers.add(name);
    for (const key of COMMAND_KEYS) if (settings[key] !== undefined) commands.push(key);
    // A key not known to be harmless counts, so a setting Gram hasn't met is asked about.
    for (const key of Object.keys(settings))
      if (!READ_KEYS.has(key) && !HARMLESS_KEYS.has(key)) other.push(`${rel}: ${key}`);
    for (const key of Object.keys(permissions))
      if (!NARROWING_PERMISSIONS.has(key)) other.push(`${rel}: permissions.${key}`);
  }
  other.push(...definitions(real));

  const mcp = load(MCP_FILE);
  if (mcp !== undefined && isObject(mcp["mcpServers"]))
    for (const name of Object.keys(mcp["mcpServers"])) mcpServers.add(name);

  const scripts: Array<{ name: string; shortcut?: string }> = [];
  const scriptsText = read(real, SCRIPTS_FILE);
  if (scriptsText === null) unreadable.push(SCRIPTS_FILE);
  else if (scriptsText !== undefined) {
    const parsed = parseScriptsFile(scriptsText);
    if ("error" in parsed) unreadable.push(SCRIPTS_FILE);
    else
      for (const script of parsed.scripts)
        scripts.push(
          script.shortcut === undefined
            ? { name: script.name }
            : { name: script.name, shortcut: script.shortcut },
        );
  }

  const none =
    hooks.length === 0 &&
    mcpServers.size === 0 &&
    allowRules === 0 &&
    env.size === 0 &&
    commands.length === 0 &&
    scripts.length === 0 &&
    unreadable.length === 0 &&
    other.length === 0;
  return {
    hooks,
    mcpServers: [...mcpServers],
    allowRules,
    env: [...env],
    commands,
    scripts,
    unreadable,
    other,
    none,
  };
};

/**
 * Whether the project's own agent settings and scripts may load: the user said so, or they were
 * never asked and the folder brings nothing (`bringsNothing`, read only then).
 */
export const projectFolderTrusted = (
  project: Pick<Project, "folderTrust">,
  bringsNothing: () => boolean,
): boolean =>
  project.folderTrust === "trusted" || (project.folderTrust === undefined && bringsNothing());

/** `bringsNothing` for `projectFolderTrusted`: a folder that can't be read brings something. */
export const folderBringsNothing = (root: string) => (): boolean => {
  try {
    return folderSettings(root).none;
  } catch {
    return false;
  }
};
