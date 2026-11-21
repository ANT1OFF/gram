import type { ConfiguredServer } from "@gram/contracts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describeClaudeEntry } from "../mcp-native.ts";

/**
 * Where Claude Code keeps its global config, as it picks it (SDK 0.3.284): a `.config.json`
 * in its config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`) while one is there, else `.claude.json`
 * in `CLAUDE_CONFIG_DIR` or the home, named `.claude-custom-oauth.json` under a custom OAuth URL.
 */
export const claudeUserConfigPath = (
  home: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync,
): string => {
  const configDir = env["CLAUDE_CONFIG_DIR"] || undefined;
  const configJson = join(configDir ?? join(home, ".claude"), ".config.json");
  if (exists(configJson)) return configJson;
  const suffix = env["CLAUDE_CODE_CUSTOM_OAUTH_URL"] ? "-custom-oauth" : "";
  return join(configDir ?? home, `.claude${suffix}.json`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (text: string | undefined): Record<string, unknown> => {
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

const described = (servers: unknown, scope: string): ReadonlyArray<ConfiguredServer> =>
  isRecord(servers)
    ? Object.entries(servers).flatMap(([name, entry]) => {
        const description = describeClaudeEntry(entry);
        return description === undefined ? [] : [{ name, scope, ...description }];
      })
    : [];

/**
 * The servers in `userConfig` (`.claude.json`'s text) and `projectConfig` (`.mcp.json`'s) as seen
 * from `cwd`. A name in several scopes is listed once, from the scope Claude Code lets win: local,
 * then project, then user.
 */
export const claudeConfiguredServers = (
  userConfig: string | undefined,
  projectConfig: string | undefined,
  cwd: string | undefined,
): ReadonlyArray<ConfiguredServer> => {
  const user = parsed(userConfig);
  const projects = user["projects"];
  const project = cwd !== undefined && isRecord(projects) ? projects[cwd] : undefined;
  const found = new Map<string, ConfiguredServer>();
  for (const server of [
    ...described(user["mcpServers"], "user"),
    ...described(parsed(projectConfig)["mcpServers"], "project"),
    ...described(isRecord(project) ? project["mcpServers"] : undefined, "local"),
  ]) {
    found.set(server.name, server);
  }
  return [...found.values()];
};

const readIfPresent = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

/** `claudeConfiguredServers` over the real files. */
export const readClaudeConfiguredServers = async (
  cwd: string | undefined,
  userConfigPath: string = claudeUserConfigPath(),
): Promise<ReadonlyArray<ConfiguredServer>> => {
  const [userConfig, projectConfig] = await Promise.all([
    readIfPresent(userConfigPath),
    cwd === undefined ? undefined : readIfPresent(join(cwd, ".mcp.json")),
  ]);
  return claudeConfiguredServers(userConfig, projectConfig, cwd);
};

/**
 * The claude.ai connectors Claude Code has ever connected, by name, from `.claude.json`'s text
 * (`claudeAiMcpEverConnected`). Only that key's strings leave; anything unreadable is none.
 */
export const claudeEverConnected = (userConfig: string | undefined): ReadonlyArray<string> => {
  const names = parsed(userConfig)["claudeAiMcpEverConnected"];
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
};

/** `claudeEverConnected` over the real file, for a session whose child runs with `env`. */
export const readClaudeEverConnected = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<ReadonlyArray<string>> =>
  claudeEverConnected(await readIfPresent(claudeUserConfigPath(homedir(), env)));
