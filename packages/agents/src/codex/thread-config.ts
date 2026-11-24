import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import { listsLeaveOut, type McpLists } from "../mcp-lists.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { McpServerStatus } from "./protocol/v2/McpServerStatus.ts";

/** Each name as a thread-config table that switches it off. */
export const switchedOff = (keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.map((name) => [name, { enabled: false }]));

/**
 * The thread config that switches off every MCP server and ChatGPT app `config/read` names for
 * `cwd`, project layers included, except `own`: Gram's app tools, which the session states
 * itself. Codex starts them itself, outside the sandbox, so a confined
 * session can't keep them. Each goes by name: a `mcp_servers` table in the thread config merges
 * into the user's rather than replacing it (measured on codex 0.158.0). Plugin servers are loaded
 * separately and aren't all named by `config/read`; confined threads disable plugin loading too.
 * ChatGPT's built-in apps server is feature-owned, so app policy alone doesn't stop it starting.
 */
export const confinedConfig = (read: ConfigReadResponse, own: string | undefined) => {
  const names = (key: string) => {
    const table = read.config[key];
    return typeof table === "object" && table !== null && !Array.isArray(table)
      ? Object.keys(table)
      : [];
  };
  return {
    mcp_servers: switchedOff(names("mcp_servers").filter((name) => name !== own)),
    features: { plugins: false, apps: false },
    apps: {
      ...switchedOff(names("apps").filter((name) => name !== "_default")),
      _default: { enabled: false },
    },
  };
};

/**
 * The thread config that switches off each MCP server `config/read` names for `cwd` that the
 * session's lists leave out (`listsLeaveOut`), matched by its name and the `url` its table gives;
 * `own` is Gram's, which stays. ChatGPT apps aren't MCP servers here, and keep to the user's
 * config.
 */
export const leftOutConfig = (
  read: ConfigReadResponse,
  lists: McpLists,
  own: string | undefined,
): Record<string, { enabled: boolean }> => {
  const tables = read.config["mcp_servers"];
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) return {};
  return switchedOff(
    Object.entries(tables)
      .filter(([name]) => name !== own)
      .filter(([name, table]) => {
        const url =
          typeof table === "object" && table !== null && "url" in table ? table.url : undefined;
        return listsLeaveOut(lists, { name, url: typeof url === "string" ? url : undefined });
      })
      .map(([name]) => name),
  );
};

/**
 * The `.codex` folders of the project layers Codex loads for a `config/read` with layers: those
 * the user's Codex trusts, whose MCP servers, hooks and rules would run with the session.
 * `undefined` when Codex didn't list its layers, so what it loads can't be told.
 */
export const loadedProjectLayers = (read: ConfigReadResponse): ReadonlyArray<string> | undefined =>
  read.layers === null || !Array.isArray(read.layers)
    ? undefined
    : read.layers.flatMap((layer) =>
        layer.name.type === "project" && typeof layer.disabledReason !== "string"
          ? [layer.name.dotCodexFolder]
          : [],
      );

/**
 * The servers a confined thread still has running that aren't Gram's own, by name: a
 * plugin's, or anything else `confinedConfig` couldn't name beforehand.
 */
export const unconfinedServers = (
  statuses: ReadonlyArray<McpServerStatus>,
  ownServer: boolean,
): ReadonlyArray<string> =>
  statuses
    .filter((status) => !(ownServer && status.name === APP_TOOLS_SERVER_NAME))
    .filter((status) => status.runtimeStatus !== "disabled")
    .map((status) => status.name);

/**
 * The thread config that gives what a session's commands run a temp folder of the thread's own
 * (`OpenSessionOptions.tmpDir`). Codex serves every session from one process, so the folder can't
 * be that process's `TMPDIR`: it is set on the environment each command of this thread gets
 * (`shell_environment_policy.set`, which wins over what the command would inherit). A `set` table
 * in the thread config merges into the user's, as `mcp_servers` does.
 */
export const tmpConfig = (tmpDir: string | undefined) =>
  tmpDir === undefined ? {} : { shell_environment_policy: { set: { TMPDIR: tmpDir } } };
