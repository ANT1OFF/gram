import {
  connectorHealth,
  MCP_TARGET_LABEL,
  MCP_TARGET_SCOPES,
  type AgentConfiguredServers,
  type CatalogueServer,
  type ConfiguredConnectors,
  type ConfiguredConnectorsPayload,
  type ConfiguredServer,
  type Connector,
  type McpScope,
  type McpServerConfig,
  type McpTarget,
} from "@gram/contracts";

import type { McpDraft } from "./mcp-config";

/** Above this many connectors the panel offers a name filter. */
export const FILTER_FROM = 8;

/** Up to this many not-signed-in connectors are listed open; more start folded away. */
export const SIGNED_OUT_OPEN_UP_TO = 3;

export interface ConnectorGroups {
  /** Everything the thread is using or tried to: connected, failed, connecting, disabled. */
  readonly inUse: ReadonlyArray<Connector>;
  /**
   * Servers that are on offer but not signed in to. An organisation's catalogue puts dozens here
   * and most stay here for good, so this is a shelf to pick from, not a list of problems.
   */
  readonly signedOut: ReadonlyArray<Connector>;
}

/** A managed runtime's server signs in through the runtime, never the agent, so it stays in use. */
const signedOut = (c: Connector) => connectorHealth(c) === "needs-auth";

/** The connectors matching `filter` by name, split by whether the user has signed in to them. */
export const groupConnectors = (
  connectors: ReadonlyArray<Connector>,
  filter: string,
): ConnectorGroups => {
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === "" ? connectors : connectors.filter((c) => c.name.toLowerCase().includes(needle));
  return {
    inUse: shown.filter((c) => !signedOut(c)),
    signedOut: shown.filter(signedOut),
  };
};

/** Whether any connector is still being checked, so the panel looks again until each is known. */
export const anyChecking = (connectors: ReadonlyArray<Connector>): boolean =>
  connectors.some((c) => connectorHealth(c) === "connecting");

/** claude.ai's hosted connectors reach Claude threads only; no other agent can load them. */
export const isClaudeHosted = (connector: Connector): boolean => connector.scope === "claudeai";

export const MCP_TARGETS: ReadonlyArray<McpTarget> = ["claude", "codex"];

/**
 * Why another agent may be refused a claude.ai connector's server: some Anthropic-hosted ones take
 * only claude.ai's own sign-in redirect. Other servers have their own policies.
 */
export const ELSEWHERE_SIGN_IN_HINT =
  "Some Anthropic-hosted connectors (Microsoft 365, Gmail …) accept only claude.ai's sign-in, so this agent's may be refused.";

/**
 * The name a claude.ai connector gets in another agent's config: its display name without `claude.ai` or a ` (2)`, as a config key.
 */
export const elsewhereName = (name: string, _url: string): string => {
  const slug = name
    .replace(/^claude\.ai\s+/i, "")
    .replace(/\s*\(\d+\)$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug === "" ? "connector" : slug;
};

/** `base`, or `base-2`, `base-3` … : the first that no server in `taken` is called. */
const freeName = (base: string, taken: ReadonlyArray<ConfiguredServer>) => {
  const names = new Set(taken.map((server) => server.name));
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!names.has(name)) return name;
  }
};

/**
 * What `target` has, read afresh before a copy picks a name for it: the agents' writers replace a
 * server of the same name, a last read may predate one added outside Gram, and a read that
 * failed says nothing, so that refuses rather than guess.
 */
export const freshServersOf = async (
  read: (payload: ConfiguredConnectorsPayload) => Promise<ConfiguredConnectors>,
  target: McpTarget,
  cwd?: string,
): Promise<ReadonlyArray<ConfiguredServer>> => {
  const { agents } = await read({ ...(cwd === undefined ? {} : { cwd }), fresh: true });
  const agent = agents.find((listed) => listed.target === target);
  const label = MCP_TARGET_LABEL[target];
  if (agent === undefined || agent.error !== undefined) {
    throw new Error(
      `Couldn't read ${label}'s config, so it isn't known what it has already${agent?.error === undefined ? "" : `: ${agent.error}`}. Refresh and try again.`,
    );
  }
  return agent.servers;
};

/** A claude.ai connector's server for another agent: one it already has, or the form to add it. */
export type ElsewhereCopy =
  | { readonly kind: "present"; readonly name: string }
  | { readonly kind: "form"; readonly draft: Partial<McpDraft>; readonly note: string };

/**
 * A claude.ai connector, to be added to another agent by its upstream address, which then signs
 * in itself: Claude's token is never copied. `taken` is what that agent has already: one at the
 * same address is the server itself, and the name filled in is one none of them has, since the
 * agents' writers replace a server of the same name, URL and credentials included.
 */
export const elsewhereDraft = (
  name: string,
  url: string,
  taken: ReadonlyArray<ConfiguredServer> = [],
  target?: McpTarget,
): ElsewhereCopy => {
  // Codex signs in at an address derived from the exact URL, so a copy differing by so much as a
  // trailing slash isn't this server for Codex, as in `catalogueRows`.
  // A query may pick a tenant or carry a credential, and either side's arrives masked, so an
  // address with one is never known to be the same server: the form opens instead.
  const same = (other: string) =>
    !other.includes("?") &&
    !url.includes("?") &&
    (target === "codex" ? other === url : addressKey(other) === addressKey(url));
  const present = taken.find((server) => server.url !== undefined && same(server.url));
  if (present !== undefined) return { kind: "present", name: present.name };
  // A masked query is no use to the next agent; the form starts from the bare address.
  const bare = url.replace(/\?.*$/, "");
  const notes = [
    "The agent signs in to the server itself; your Claude sign-in isn't shared.",
    bare === url ? undefined : "Its address's query values stay masked here; enter them again.",
    ELSEWHERE_SIGN_IN_HINT,
  ];
  return {
    kind: "form",
    draft: { name: freeName(elsewhereName(name, url), taken), transport: "http", url: bare },
    note: notes.filter((note) => note !== undefined).join(" "),
  };
};

/** One server name across the agents: each agent's own entry for it, where it has one. */
export interface ConnectorMatrixRow {
  readonly name: string;
  readonly cells: Readonly<Partial<Record<McpTarget, ConfiguredServer>>>;
  /** The address to show: the first agent's that has one. */
  readonly address: string | undefined;
}

export interface ConnectorMatrix {
  readonly inUse: ReadonlyArray<ConnectorMatrixRow>;
  /**
   * Servers some agent says it isn't signed in to and none says it is. As in the thread's panel,
   * a catalogue leaves most of its servers here for good: a shelf, not a list of problems.
   */
  readonly signedOut: ReadonlyArray<ConnectorMatrixRow>;
  readonly total: number;
}

const addressOf = (server: ConfiguredServer): string | undefined =>
  server.url ?? (server.command && [server.command, ...(server.args ?? [])].join(" "));

const isSignedOut = ({ cells }: ConnectorMatrixRow) => {
  const states = Object.values(cells).map((server) => server.signedIn);
  return states.includes(false) && !states.includes(true);
};

/** Every agent's servers as one row per name, sorted by name and filtered by it. */
export const connectorMatrix = (
  agents: ReadonlyArray<AgentConfiguredServers>,
  filter: string,
): ConnectorMatrix => {
  const byName = new Map<string, Partial<Record<McpTarget, ConfiguredServer>>>();
  for (const { target, servers } of agents) {
    for (const server of servers) {
      byName.set(server.name, { ...byName.get(server.name), [target]: server });
    }
  }
  const needle = filter.trim().toLowerCase();
  const rows = [...byName]
    .filter(([name]) => name.toLowerCase().includes(needle))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, cells]): ConnectorMatrixRow => ({
      name,
      cells,
      address: MCP_TARGETS.flatMap((target) => {
        const address = cells[target] && addressOf(cells[target]);
        return address ? [address] : [];
      })[0],
    }));
  return {
    inUse: rows.filter((row) => !isSignedOut(row)),
    signedOut: rows.filter(isSignedOut),
    total: byName.size,
  };
};

/** `codex`'s sign-in states, asked for separately, laid over a listing that came without them. */
export const withSignIns = (
  agents: ReadonlyArray<AgentConfiguredServers>,
  checked: ReadonlyArray<AgentConfiguredServers> | undefined,
): ReadonlyArray<AgentConfiguredServers> =>
  agents.map((agent) => {
    const known = checked?.find(
      (other) => other.target === agent.target && agent.signIn === "onRequest",
    );
    if (known === undefined) return agent;
    return {
      ...agent,
      servers: agent.servers.map((server) => {
        const signedIn = known.servers.find((other) => other.name === server.name)?.signedIn;
        return signedIn === undefined ? server : { ...server, signedIn };
      }),
    };
  });

/** Whether Gram can remove `server` from `target`: only from a scope it can write. */
export const isRemovable = (target: McpTarget, server: ConfiguredServer): boolean =>
  (MCP_TARGET_SCOPES[target] as ReadonlyArray<string>).includes(server.scope);

/**
 * How a server one agent has gets to `target`, which lacks it. A remote server that sends nothing of
 * its own is added as it stands; anything else opens the form with what's known filled in, because
 * header and env values never reach the UI, an address that held a credential arrives masked
 * (`carriesValues` covers both), and a claude.ai connector's address isn't known at all.
 */
export type ConnectorCopy =
  | { readonly kind: "direct"; readonly scope: McpScope; readonly config: McpServerConfig }
  | ElsewhereCopy;

/** `taken` is what `target` has already, against which a claude.ai connector's name is picked. */
export const copyTo = (
  row: ConnectorMatrixRow,
  target: McpTarget,
  hasFolder: boolean,
  taken: ReadonlyArray<ConfiguredServer> = [],
): ConnectorCopy => {
  const sources = MCP_TARGETS.flatMap((other) => (row.cells[other] ? [row.cells[other]] : []));
  const source = sources.find((server) => server.url !== undefined) ?? sources[0];
  if (source?.scope === "claudeai" && source.url !== undefined) {
    return elsewhereDraft(row.name, source.url, taken, target);
  }
  if (source === undefined || source.scope === "claudeai" || source.transport === "other") {
    return {
      kind: "form",
      draft: { name: row.name },
      note:
        source?.scope === "claudeai"
          ? "A claude.ai connector reaches Claude threads only. Enter the server's own URL to add it here."
          : "Enter the server's address to add it here.",
    };
  }
  const narrow = hasFolder && (source.scope === "local" || source.scope === "project");
  const scope: McpScope = narrow ? (source.scope as McpScope) : "user";
  if (
    source.url !== undefined &&
    !source.carriesValues &&
    !(source.transport === "sse" && target === "codex")
  ) {
    const type = source.transport === "sse" ? "sse" : "http";
    return { kind: "direct", scope, config: { type, url: source.url } };
  }
  return {
    kind: "form",
    draft:
      source.url === undefined
        ? {
            name: row.name,
            transport: "stdio",
            command: source.command ?? "",
            args: (source.args ?? []).join("\n"),
          }
        : {
            name: row.name,
            transport: source.transport === "sse" ? "sse" : "http",
            // A masked query is no use to the next agent; the form starts from the bare address.
            url: source.url.replace(/\?.*$/, ""),
          },
    note: source.carriesValues
      ? "Its credentials (header, environment or address values) stay with the agent that has them. Enter them again here."
      : "Check the details, then add it.",
  };
};

/** An address as one server's, whatever its case of host or a trailing slash. */
const addressKey = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
};

/** A platform server beside each agent's own copy of it, found by its address. */
export interface CatalogueRow {
  readonly server: CatalogueServer;
  /** Named by the server's id; a cell holds the agent's copy under whatever name it has there. */
  readonly row: ConnectorMatrixRow;
  /**
   * Why the server can't be added to an agent from here: the name is taken by another server, or
   * the agent's copy is at an address the platform won't accept its sign-in for.
   */
  readonly blocked: Readonly<Partial<Record<McpTarget, string>>>;
  /** The agents that lack it and can sign in to it: what setting it up everywhere adds it to. */
  readonly missing: ReadonlyArray<McpTarget>;
}

/** The catalogue matching `filter` by id, title or description, with what each agent has of it. */
export const catalogueRows = (
  servers: ReadonlyArray<CatalogueServer>,
  agents: ReadonlyArray<AgentConfiguredServers>,
  filter: string,
): ReadonlyArray<CatalogueRow> => {
  const needle = filter.trim().toLowerCase();
  return servers
    .filter((server) =>
      [server.id, server.title, server.description ?? ""].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    )
    .map((server) => {
      const key = addressKey(server.url);
      const cells: Partial<Record<McpTarget, ConfiguredServer>> = {};
      const blocked: Partial<Record<McpTarget, string>> = {};
      for (const { target, servers: configured } of agents) {
        const label = MCP_TARGET_LABEL[target];
        const copy = configured.find((c) => c.url !== undefined && addressKey(c.url) === key);
        // Codex signs in at an address derived from the exact URL, so a copy differing by so much
        // as a trailing slash is refused, and isn't this server for Codex.
        if (copy !== undefined && (target !== "codex" || copy.url === server.url)) {
          cells[target] = copy;
          continue;
        }
        const named = configured.find((c) => c.name === server.id);
        if (copy !== undefined) {
          blocked[target] =
            `${label} has it at ${copy.url}, and the platform accepts ${label}'s sign-in only at ${server.url}. Remove that copy in the table above, then add it here.`;
        } else if (named !== undefined) {
          blocked[target] =
            `${label} already has a server called ${server.id}${named.url === undefined ? "" : ` at ${named.url}`}. Adding this one would replace it, so remove that one in the table above first, or add this under another name with Add server….`;
        }
      }
      const unsupported = server.signInUnsupported ?? [];
      return {
        server,
        row: { name: server.id, cells, address: server.url },
        blocked,
        missing: MCP_TARGETS.filter(
          (target) =>
            cells[target] === undefined &&
            blocked[target] === undefined &&
            !unsupported.includes(target) &&
            agents.some((agent) => agent.target === target && agent.error === undefined),
        ),
      };
    });
};
