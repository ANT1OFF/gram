import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { APP_TOOLS_SERVER_NAME, type OutwardGate } from "@gram/agents";
import { CATALOG_DIR, outwardPromptRules } from "@gram/agents/codex";
export { outwardPromptRules, OUTWARD_PROMPT_RULES } from "@gram/agents/codex";
import * as Effect from "effect/Effect";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { assertOwnedCodexPath } from "./codex-owned-path.ts";
import { normaliseUrl } from "./seed.ts";

/** The user's own Codex home: `CODEX_HOME`, else `~/.codex`. */
const userCodexHome = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  env["CODEX_HOME"] ?? join(home, ".codex");

const tomlTable = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const tomlText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * The model a parsed Codex `config.toml` uses on `baseURL`: the top-level `model` when the active
 * `model_provider` has that base URL, else the first `[profiles.*]` entry on such a provider.
 */
export const codexModelIn = (config: unknown, baseURL: string): string | undefined => {
  const root = tomlTable(config);
  const target = normaliseUrl(baseURL);
  const providers = Object.entries(tomlTable(root?.["model_providers"]) ?? {}).flatMap(
    ([name, provider]) => {
      const url = tomlText(tomlTable(provider)?.["base_url"]);
      return url !== undefined && normaliseUrl(url) === target ? [name] : [];
    },
  );
  if (providers.length === 0) return undefined;
  const active = tomlText(root?.["model_provider"]);
  const model = tomlText(root?.["model"]);
  if (active !== undefined && providers.includes(active) && model !== undefined) return model;
  for (const entry of Object.values(tomlTable(root?.["profiles"]) ?? {})) {
    const profile = tomlTable(entry);
    const provider = tomlText(profile?.["model_provider"]);
    const profileModel = tomlText(profile?.["model"]);
    if (provider !== undefined && providers.includes(provider) && profileModel !== undefined) {
      return profileModel;
    }
  }
  return undefined;
};

/**
 * The model the user's own Codex config (`CODEX_HOME`, else `~/.codex`) uses on a gateway's base URL,
 * read on each call and never written; `undefined` without a config or a matching provider.
 */
export const codexModelFor =
  (home: string, env: Readonly<Record<string, string | undefined>> = process.env) =>
  (baseURL: string): Effect.Effect<string | undefined> =>
    Effect.promise(async () => {
      try {
        const config = parseToml(
          await readFile(join(userCodexHome(home, env), "config.toml"), "utf8"),
        );
        return codexModelIn(config, baseURL);
      } catch {
        return undefined;
      }
    });

/**
 * Where the gateway home records what its threads take from the user's own Codex setup, as paths
 * only: the skill folders they see and the instructions copied in. Diagnostics reads it, since only
 * the adapter knows the login shell's `CODEX_HOME`.
 */
export const INHERITED_FILE = "gram-inherited.json";

/** What `INHERITED_FILE` holds. */
export interface CodexInheritance {
  readonly skills: ReadonlyArray<string>;
  readonly instructions?: string;
}

/** Codex's global instruction files in a home, in the order it tries them (0.159.2). */
const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The global instructions Codex would read from `codexHome`: the first of `INSTRUCTION_FILES` that
 * is a file with more than whitespace in it, as Codex picks them.
 */
const effectiveInstructions = async (
  codexHome: string,
): Promise<{ readonly path: string; readonly text: string } | undefined> => {
  for (const name of INSTRUCTION_FILES) {
    const path = join(codexHome, name);
    try {
      if (!(await stat(path)).isFile()) continue;
      const text = await readFile(path, "utf8");
      if (text.trim() !== "") return { path, text };
    } catch {
      // Missing or unreadable: Codex moves on to the next name too.
    }
  }
  return undefined;
};

/**
 * The user's skill folders a gateway Codex doesn't find from its own home: their `CODEX_HOME/skills`
 * (`~/.codex/skills`). `~/.agents/skills` needs nothing, since Codex finds it from `HOME`.
 */
export const codexSkillRoots = (
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(async () => {
    const skills = join(userCodexHome(home, env), "skills");
    return (await isDirectory(skills)) ? [skills] : [];
  });

const syncInstructions = async (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> => {
  const target = join(dataDir, "codex-home");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const source = await effectiveInstructions(userCodexHome(home, env));
  const copy = join(target, "AGENTS.md");
  await rm(join(target, "AGENTS.override.md"), { force: true });
  if (source === undefined) {
    await rm(copy, { force: true });
  } else {
    const current = await readFile(copy, "utf8").catch(() => undefined);
    if (current !== source.text) {
      await writeFile(copy, source.text, { mode: 0o600 });
      await chmod(copy, 0o600);
    }
  }
  const skills: Array<string> = [];
  for (const dir of [
    join(env["HOME"] ?? home, ".agents", "skills"),
    join(userCodexHome(home, env), "skills"),
  ]) {
    if (await isDirectory(dir)) skills.push(dir);
  }
  const inherited: CodexInheritance = {
    skills,
    ...(source === undefined ? {} : { instructions: source.path }),
  };
  await writeFile(join(target, INHERITED_FILE), `${JSON.stringify(inherited, null, 2)}\n`, {
    mode: 0o600,
  });
  return source?.path;
};

/**
 * Copies the user's global Codex instructions (`AGENTS.override.md`, else `AGENTS.md`) into the
 * gateway home as its `AGENTS.md`, and removes the copy once they have none; the gateway home's own
 * `AGENTS.override.md` is removed so it can't shadow it. Records what the home inherits in
 * `INHERITED_FILE`. Nothing else crosses: never auth, sessions, rules, hooks, plugins, `notify` or
 * project trust. `env` is the user's, where their `CODEX_HOME` is set. Returns the source's path; a
 * failed copy is logged, and the thread opens on the copy it had.
 */
export const syncCodexInstructions = (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<string | undefined> =>
  Effect.tryPromise(() => syncInstructions(dataDir, home, env)).pipe(
    // A thread still opens, on the copy it had; the error names a path, never the file's text.
    Effect.catch((error) =>
      Effect.logWarning(
        `couldn't copy Codex instructions to the gateway home: ${error.message}`,
      ).pipe(Effect.as(undefined)),
    ),
  );

/**
 * What gateway Codex threads took from the user's own Codex setup when one last opened, from
 * `INHERITED_FILE`; nothing before any has. Reads one file and starts nothing.
 */
export const codexGatewayInheritance = (dataDir: string): Effect.Effect<CodexInheritance> =>
  Effect.promise(async () => {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(dataDir, "codex-home", INHERITED_FILE), "utf8"),
      );
      const record = tomlTable(value);
      const skills = Array.isArray(record?.["skills"])
        ? (record["skills"] as ReadonlyArray<unknown>).filter(
            (dir): dir is string => typeof dir === "string",
          )
        : [];
      const instructions = record?.["instructions"];
      return typeof instructions === "string" ? { skills, instructions } : { skills };
    } catch {
      return { skills: [] };
    }
  });

/** The file under the home's `rules/` that holds `outwardPromptRules`. */
export const OUTWARD_RULES_FILE = "gram-outward.rules";

const outwardRulesPath = (dataDir: string, home: "gateway" | "owned" = "gateway"): string =>
  join(dataDir, home === "owned" ? "codex-owned-home" : "codex-home", "rules", OUTWARD_RULES_FILE);

/**
 * Gram's own `CODEX_HOME` for gateway Codex sessions, under the data dir, so they never read
 * or write the user's Codex auth, sessions or config. Its `config.toml` holds only the user's
 * `[mcp_servers]` and `[skills]` tables, re-read (never written back) each time a gateway
 * app-server starts, and their global instructions are copied in (`syncCodexInstructions`). The
 * gateway provider itself arrives as `-c` overrides, and its key only in the child env. A user entry
 * named like our app-tools server is left out, so its fields never merge into the per-thread one.
 *
 * The copied table may hold MCP `env` tokens, so the file is private to the user (0600, in a 0700
 * dir on posix; under `%APPDATA%` Windows already scopes it to the user), and is never logged.
 *
 * A gateway Codex session under the outward gate runs on this home (`gatedHomeIsOwned` in the
 * adapter); native gated sessions use the separate owned home, where `installOutwardRules` can put its prompt rules; the user's `~/.codex` can hold
 * allow rules nothing here may touch. A rules file a crash left behind is removed here, because
 * while it stays every ungated bypass session has its pushes rejected (see `installOutwardRules`).
 */
export const prepareCodexHome = (
  dataDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    const target = join(dataDir, "codex-home");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, 0o700);
    // A shell snapshot captures the app-server env, key included: none may stay in this home.
    await rm(join(target, "shell_snapshots"), { recursive: true, force: true });
    let servers: Record<string, unknown> | undefined;
    // Which skills are turned off, and whether bundled ones load: preferences with no command in them.
    let skills: Record<string, unknown> | undefined;
    try {
      const config = parseToml(
        await readFile(join(userCodexHome(home, env), "config.toml"), "utf8"),
      );
      const table = config["mcp_servers"];
      if (typeof table === "object" && table !== null && !Array.isArray(table)) {
        const { [APP_TOOLS_SERVER_NAME]: _ours, ...rest } = table as Record<string, unknown>;
        servers = rest;
      }
      skills = tomlTable(config["skills"]);
    } catch {
      servers = undefined;
    }
    const copied = {
      ...(servers !== undefined && Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}),
      ...(skills !== undefined && Object.keys(skills).length > 0 ? { skills } : {}),
    };
    const table =
      Object.keys(copied).length > 0
        ? `# Written by Gram for gateway sessions: the MCP servers and skill settings from your Codex config.\n${stringifyToml(copied)}\n`
        : "";
    const file = join(target, "config.toml");
    await writeFile(file, table, { mode: 0o600 });
    await chmod(file, 0o600);
    await rm(outwardRulesPath(dataDir), { force: true });
    await syncInstructions(dataDir, home, env);
    return target;
  });

/**
 * Removes the copied `config.toml`, instructions and gateway model catalogs once no gateway
 * app-server needs them; the sessions stay.
 */
export const releaseCodexHome = (dataDir: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    await rm(join(dataDir, "codex-home", "config.toml"), { force: true });
    await rm(join(dataDir, "codex-home", "AGENTS.md"), { force: true });
    await rm(join(dataDir, "codex-home", CATALOG_DIR), { recursive: true, force: true });
    await rm(outwardRulesPath(dataDir), { force: true });
  });

const assertOwnedRulesPath = async (dataDir: string): Promise<void> => {
  const file = outwardRulesPath(dataDir, "owned");
  await assertOwnedCodexPath(join(dataDir, "codex-owned-home"), true);
  await assertOwnedCodexPath(dirname(file), true);
  await assertOwnedCodexPath(file);
};

/**
 * Puts the `outwardPromptRules` of `level` into the chosen Gram-owned home (0600, in a 0700 `rules/`),
 * replacing any that are there, for the moment a gated thread opens: Codex reads a home's rules as
 * a thread starts, resumes or forks and keeps that reading for the thread's life (measured on
 * 0.154.0: rules removed after `thread/start` still ask, rules added after it don't).
 * `removeOutwardRules` takes them out straight after, because the home is shared with ungated
 * sessions, and under their bypass policy (`never`) a `prompt` rule doesn't ask: Codex rejects the
 * push with "approval required by policy, but AskForApproval is set to Never". Never the user's own
 * `~/.codex`.
 */
export const installOutwardRules = (
  dataDir: string,
  level: OutwardGate = "all",
  home: "gateway" | "owned" = "gateway",
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const file = outwardRulesPath(dataDir, home);
    const dir = dirname(file);
    if (home === "owned") await assertOwnedRulesPath(dataDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(file, outwardPromptRules(level), { mode: 0o600 });
    await chmod(file, 0o600);
  });

/** Takes `outwardPromptRules` out of Gram's Codex home; rules Codex wrote itself stay. */
export const removeOutwardRules = (
  dataDir: string,
  home: "gateway" | "owned" = "gateway",
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (home === "owned") await assertOwnedRulesPath(dataDir);
    await rm(outwardRulesPath(dataDir, home), { force: true });
  });
