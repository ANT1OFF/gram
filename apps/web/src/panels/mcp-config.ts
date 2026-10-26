import {
  MCP_SERVER_NAME_PATTERN,
  MCP_TARGET_LABEL,
  mcpScopeFor,
  type McpScope,
  type McpServerConfig,
  type McpTarget,
} from "@gram/contracts";

export type McpTransport = McpServerConfig["type"];

export interface McpDraft {
  transport: McpTransport;
  name: string;
  command: string;
  /** One argument per line, so an argument with spaces stays whole. */
  args: string;
  /** `KEY=value` per line. */
  env: string;
  url: string;
  /** `Name: value` per line. */
  headers: string;
}

export const EMPTY_DRAFT: McpDraft = {
  transport: "http",
  name: "",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
};

export type Parsed = { name: string; config: McpServerConfig } | { error: string };

const nameProblem = (name: string): string | undefined =>
  MCP_SERVER_NAME_PATTERN.test(name)
    ? undefined
    : "Name the server with letters, digits, dashes or underscores.";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** `KEY=value` or `Name: value` lines as a map, or the first line that isn't one. */
export function parsePairs(
  text: string,
  separator: "=" | ":",
): { pairs: Record<string, string> } | { error: string } {
  const pairs: Record<string, string> = {};
  for (const line of lines(text)) {
    const at = line.indexOf(separator);
    const key = at === -1 ? "" : line.slice(0, at).trim();
    if (key === "") {
      const example = separator === "=" ? "KEY=value" : "Name: value";
      return { error: `Expected ${example}, one per line: ${line.slice(0, 20)}` };
    }
    pairs[key] = line.slice(at + 1).trim();
  }
  return { pairs };
}

const withPairs = (pairs: Record<string, string>) => Object.keys(pairs).length > 0;

/** The form's fields as a server, or the first problem. */
export function configFromDraft(draft: McpDraft): Parsed {
  const name = draft.name.trim();
  const problem = nameProblem(name);
  if (problem) return { error: problem };
  if (draft.transport === "stdio") {
    const command = draft.command.trim();
    if (command === "") return { error: "Enter the command that starts the server." };
    const env = parsePairs(draft.env, "=");
    if ("error" in env) return env;
    const args = lines(draft.args);
    return {
      name,
      config: {
        type: "stdio",
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(withPairs(env.pairs) ? { env: env.pairs } : {}),
      },
    };
  }
  const url = draft.url.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return { error: "Enter the server's http(s) URL." };
  const headers = parsePairs(draft.headers, ":");
  if ("error" in headers) return headers;
  return {
    name,
    config: {
      type: draft.transport,
      url,
      ...(withPairs(headers.pairs) ? { headers: headers.pairs } : {}),
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringMap = (value: unknown): Record<string, string> | undefined =>
  isRecord(value) && Object.values(value).every((v) => typeof v === "string")
    ? (value as Record<string, string>)
    : undefined;

/**
 * A pasted server: one entry (`{"type": "http", "url": …}`, named by the form) or a `.mcp.json`
 * style `{"mcpServers": {"name": {…}}}` with exactly one server. An entry without `type` but with a
 * `command` is stdio, as Claude Code reads it.
 */
export function configFromJson(text: string, formName: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "That isn't valid JSON." };
  }
  let name = formName.trim();
  let entry = value;
  if (isRecord(value) && isRecord(value["mcpServers"])) {
    const servers = Object.entries(value["mcpServers"]);
    if (servers.length !== 1) return { error: "Paste one server at a time." };
    [name, entry] = servers[0]!;
  }
  if (!isRecord(entry)) return { error: "Expected a server object." };
  const type = entry["type"] ?? (typeof entry["command"] === "string" ? "stdio" : undefined);
  const draft: McpDraft = { ...EMPTY_DRAFT, name };
  if (type === "stdio") {
    const args = entry["args"] ?? [];
    const env = entry["env"] ?? {};
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      return { error: "`args` must be a list of strings." };
    }
    const envMap = stringMap(env);
    if (!envMap) return { error: "`env` must map names to strings." };
    const parsed = configFromDraft({
      ...draft,
      transport: "stdio",
      command: typeof entry["command"] === "string" ? entry["command"] : "",
    });
    if ("error" in parsed || parsed.config.type !== "stdio") return parsed;
    return {
      name: parsed.name,
      config: {
        ...parsed.config,
        ...(args.length > 0 ? { args } : {}),
        ...(withPairs(envMap) ? { env: envMap } : {}),
      },
    };
  }
  if (type === "http" || type === "sse") {
    const headers = stringMap(entry["headers"] ?? {});
    if (!headers) return { error: "`headers` must map names to strings." };
    const parsed = configFromDraft({
      ...draft,
      transport: type,
      url: typeof entry["url"] === "string" ? entry["url"] : "",
    });
    if ("error" in parsed || parsed.config.type === "stdio") return parsed;
    return {
      name: parsed.name,
      config: { ...parsed.config, ...(withPairs(headers) ? { headers } : {}) },
    };
  }
  return { error: "`type` must be stdio, http or sse." };
}

/** Where each agent keeps a server at each of its scopes, in the user's words. */
const PLACE: Readonly<Record<McpTarget, Partial<Record<McpScope, string>>>> = {
  claude: {
    local: "only you, in this project",
    project: "everyone in the repo, via .mcp.json you can commit",
    user: "only you, in every project",
  },
  codex: { user: "its config.toml, for you in every project (Codex has no narrower scope)" },
};

/**
 * One line per chosen agent saying where the server will live. Claude Code's scope is the one
 * asked for; an agent without it gets the nearest it has, and the line says so rather than letting
 * "Local" mean something it can't.
 */
export const placementHints = (
  targets: ReadonlyArray<McpTarget>,
  scope: McpScope,
): ReadonlyArray<string> =>
  targets.map(
    (target) => `${MCP_TARGET_LABEL[target]}: ${PLACE[target][mcpScopeFor(target, scope)]}.`,
  );

/** What an agent can't run, so the form can say so before the server does. */
export const targetProblem = (
  targets: ReadonlyArray<McpTarget>,
  transport: McpTransport,
): string | undefined =>
  targets.length === 0
    ? "Pick at least one agent to add the server to."
    : transport === "sse" && targets.includes("codex")
      ? "Codex connects over streamable HTTP only. Pick HTTP, or leave Codex out."
      : undefined;
