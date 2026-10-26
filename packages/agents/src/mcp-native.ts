/**
 * The one place a `McpServerConfig` becomes an agent's own MCP server entry, and an agent's entry
 * becomes something to show. Each agent reads, runs and signs in to its servers itself, so an entry
 * carries nothing about auth: a remote server is written with the agent's OAuth discovery left on,
 * and whatever token the agent's sign-in gets stays in the agent's own store. Header and env values
 * pass through on the way in and are secrets; on the way out (`describe*Entry`) they are dropped
 * here, so no caller ever holds them.
 */
import type { ConfiguredServer, McpServerConfig, McpTarget } from "@gram/contracts";

/** An agent's entry for a server, or why the agent can't run one like it. */
export type NativeEntry =
  | { readonly entry: Record<string, unknown> }
  | { readonly unsupported: string };

const withValues = (key: string, map: Readonly<Record<string, string>> | undefined) =>
  map === undefined || Object.keys(map).length === 0 ? {} : { [key]: { ...map } };

/** Claude Code's `mcpServers` entry, as `claude mcp add-json` takes it. */
export const claudeServerEntry = (config: McpServerConfig): Record<string, unknown> =>
  config.type === "stdio"
    ? { type: "stdio", command: config.command, args: config.args ?? [], env: config.env ?? {} }
    : { type: config.type, url: config.url, ...withValues("headers", config.headers) };

/**
 * Codex's `[mcp_servers.<name>]` table. Codex speaks streamable HTTP to a `url` and has no SSE
 * client, so an SSE server is refused rather than written as something that can never connect.
 */
export const codexServerEntry = (config: McpServerConfig): NativeEntry => {
  if (config.type === "sse") {
    return { unsupported: "Codex connects over streamable HTTP only, not SSE." };
  }
  return {
    entry:
      config.type === "stdio"
        ? {
            command: config.command,
            ...(config.args === undefined || config.args.length === 0
              ? {}
              : { args: [...config.args] }),
            ...withValues("env", config.env),
          }
        : { url: config.url, ...withValues("http_headers", config.headers) },
  };
};

/** `config` as `target` keeps it. */
export const nativeServerEntry = (target: McpTarget, config: McpServerConfig): NativeEntry =>
  target === "claude" ? { entry: claudeServerEntry(config) } : codexServerEntry(config);

/** What an entry says about its server; the name, scope and sign-in come from where it was found. */
export type ServerDescription = Omit<ConfiguredServer, "name" | "scope" | "signedIn">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const holdsValues = (...maps: ReadonlyArray<unknown>) =>
  maps.some((map) =>
    isRecord(map) ? Object.keys(map).length > 0 : map !== undefined && map !== null,
  );

const local = (command: string, args: ReadonlyArray<string>, carriesValues: boolean) => ({
  transport: "stdio" as const,
  command,
  ...(args.length === 0 ? {} : { args }),
  carriesValues,
});

const switchedOff = (entry: Record<string, unknown>) =>
  entry["enabled"] === false ? { disabled: true } : {};

/** An entry of Claude Code's `mcpServers`; one without `type` but with a `command` is stdio. */
export const describeClaudeEntry = (entry: unknown): ServerDescription | undefined => {
  if (!isRecord(entry)) return undefined;
  const command = text(entry["command"]);
  const type = entry["type"] ?? (command === undefined ? undefined : "stdio");
  if (type === "stdio" && command !== undefined) {
    return local(command, strings(entry["args"]), holdsValues(entry["env"]));
  }
  const url = text(entry["url"]);
  return {
    transport: type === "http" || type === "sse" ? type : "other",
    ...(url === undefined ? {} : { url }),
    carriesValues: holdsValues(entry["headers"]),
  };
};

/**
 * A `[mcp_servers.<name>]` table of Codex's. `bearer_token_env_var` and `env_http_headers` name
 * variables rather than hold values, but a copy without them wouldn't authenticate either.
 */
export const describeCodexEntry = (entry: unknown): ServerDescription | undefined => {
  if (!isRecord(entry)) return undefined;
  const command = text(entry["command"]);
  if (command !== undefined) {
    return {
      ...local(command, strings(entry["args"]), holdsValues(entry["env"])),
      ...switchedOff(entry),
    };
  }
  const url = text(entry["url"]);
  if (url === undefined) return undefined;
  return {
    transport: "http",
    url,
    carriesValues: holdsValues(
      entry["http_headers"],
      entry["env_http_headers"],
      entry["bearer_token_env_var"],
    ),
    ...switchedOff(entry),
  };
};
