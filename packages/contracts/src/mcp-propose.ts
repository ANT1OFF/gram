// An agent proposes an MCP server (`mcp_server_propose`); the user approves it on a card that
// shows everything that would be written, and only then does Gram add it to each agent CLI's own
// MCP config, through the path Settings → Connectors uses. Pure: the server reads what the agents
// already have, raises the card and writes.
//
// A proposal never carries a credential. Anything that looks like one (a secret-named env var or
// header, a key-shaped value, a URL with a user or a token in it) is refused before any card, so
// the user adds it by hand where Gram never sees it.

import * as Schema from "effect/Schema";
import {
  MCP_SERVER_NAME_PATTERN,
  MCP_TARGET_LABEL,
  McpServerConfig,
  McpTarget,
  type ConfiguredServer,
} from "./connectors-config.ts";
import { redactText, SECRET_KEY } from "./redact.ts";

export const MCP_SERVER_PROPOSE_TOOL = "mcp_server_propose";

/** The scopes a proposal may ask for: `user` (every project) or `project` (the repo's own file). */
export const McpProposalScope = Schema.Literals(["user", "project"]);
export type McpProposalScope = typeof McpProposalScope.Type;

/** How much one proposal may carry, so the card stays readable whole. */
export const MCP_PROPOSAL_LIMITS = {
  args: 40,
  env: 20,
  headers: 10,
  /** Characters in any one name, value, argument or command. */
  value: 1000,
  url: 2000,
} as const;

/** `mcp_server_propose`'s arguments. */
export const McpServerProposeInput = Schema.Struct({
  name: Schema.String,
  /** As Claude Code's `mcpServers` entry: `stdio` with `command`, or `http`/`sse` with `url`. */
  server: McpServerConfig,
  targets: Schema.NonEmptyArray(McpTarget),
  /** `user` when absent. */
  scope: Schema.optionalKey(McpProposalScope),
  /** Replace a server of the same name; the card then shows both. */
  replace: Schema.optionalKey(Schema.Boolean),
  /** Why, in the agent's words; the card shows it. */
  reason: Schema.String.check(Schema.isMaxLength(500)),
});
export type McpServerProposeInput = typeof McpServerProposeInput.Type;

/** One name and value the card shows as they would be written: an env var or a header. */
export const McpProposalPair = Schema.Struct({ name: Schema.String, value: Schema.String });
export type McpProposalPair = typeof McpProposalPair.Type;

/** A server a target already has under the proposed name, as its config holds it, values masked. */
export const McpProposalExisting = Schema.Struct({
  transport: Schema.String,
  scope: Schema.String,
  url: Schema.optionalKey(Schema.String),
  commandLine: Schema.optionalKey(Schema.String),
  /** It has env or header values, which are never shown. */
  carriesValues: Schema.Boolean,
});
export type McpProposalExisting = typeof McpProposalExisting.Type;

export const McpProposalTarget = Schema.Struct({
  target: McpTarget,
  /** "Claude Code", "Codex". */
  label: Schema.String,
  /** Where it is written, in words, with the file or command. */
  where: Schema.String,
  /** The server it replaces there. */
  replaces: Schema.optionalKey(McpProposalExisting),
});
export type McpProposalTarget = typeof McpProposalTarget.Type;

/** What a `mcp_server_propose` card carries as its input, for the web to show whole. */
export const McpServerProposalCard = Schema.Struct({
  name: Schema.String,
  action: Schema.Literals(["add", "replace"]),
  transport: Schema.Literals(["stdio", "http", "sse"]),
  /** Remote: the URL as written, and its host (in ASCII, so a look-alike name reads as itself). */
  url: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Array(McpProposalPair)),
  /** Stdio: the command and its arguments, and the same as one shell-quoted line. */
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  commandLine: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Array(McpProposalPair)),
  scope: McpProposalScope,
  /** The scope in words. */
  scopeText: Schema.String,
  targets: Schema.Array(McpProposalTarget),
  reason: Schema.String,
  /** What the user does after, such as signing in. */
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type McpServerProposalCard = typeof McpServerProposalCard.Type;

/** A checked proposal: what would be written, and where. */
export interface McpServerProposal {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly targets: ReadonlyArray<McpTarget>;
  readonly scope: McpProposalScope;
  readonly replace: boolean;
  readonly reason: string;
}

/** Code point ranges that hide or reorder what the card shows: controls, zero-widths, bidi marks. */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const HIDDEN = new RegExp(
  `[${HIDDEN_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join("")}]`,
  "u",
);

/** Name parts that say the value is a credential, as whole parts: `API_KEY`, `X-Auth-Token`. */
const SECRET_PARTS: ReadonlySet<string> = new Set([
  "KEY",
  "APIKEY",
  "ACCESSKEY",
  "PAT",
  "PASS",
  "PASSWD",
  "PWD",
  "AUTH",
  "BEARER",
  "SIG",
  "SIGNATURE",
  "JWT",
  "OTP",
]);

/** An env var, header or query parameter whose name says it holds a credential. */
export const secretName = (name: string): boolean =>
  SECRET_KEY.test(name) ||
  name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((part) => SECRET_PARTS.has(part));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bits per character: random keys are high, words and paths low. */
const entropy = (text: string) => {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/**
 * A value shaped like a credential: a provider key or bearer token the log scrubber knows, a JWT,
 * a private key, or a long run of random-looking letters and digits. A UUID is an identifier, not
 * a key.
 */
export const secretValue = (value: string): boolean => {
  if (redactText(value) !== value) return true;
  if (/\beyJ[\w-]{8,}\.[\w-]{8,}\./.test(value)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  for (const run of value.match(/[A-Za-z0-9+=_-]{32,}/g) ?? []) {
    if (UUID.test(run)) continue;
    if (/^[0-9a-f]+$/i.test(run)) return true;
    if (/[A-Za-z]/.test(run) && /[0-9]/.test(run) && entropy(run) >= 3.8) return true;
  }
  return false;
};

/** A flag that names a credential, as `--token` or `--api-key=…`. */
const SECRET_FLAG = /^--?[\w-]*(?:token|secret|password|passphrase|api[-_]?key|credential)[\w-]*$/i;

/**
 * Env vars that change which program runs or what it loads, so the command line on the card would
 * no longer say what runs.
 */
const LOADER_ENV =
  /^(?:PATH|LD_\w+|DYLD_\w+|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV)$/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

const LOOPBACK: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

const REFUSE_SECRET =
  "Add credentials yourself in Settings → Connectors or the CLI, where Gram never sees them.";

/** Why `url` would carry a credential: a user, a secret query value, a key-shaped path. */
const urlCredential = (url: URL, where: string): string | undefined => {
  if (url.username !== "" || url.password !== "") {
    return `${where} carries a user name or password. ${REFUSE_SECRET}`;
  }
  for (const [key, value] of url.searchParams) {
    if (secretName(key) || secretValue(value)) {
      return `${where} carries a credential in its query (${key}). ${REFUSE_SECRET}`;
    }
  }
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape is checked as written.
  }
  return secretValue(path) ? `${where} has a key-shaped path. ${REFUSE_SECRET}` : undefined;
};

const parseUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** Why `url` can't be proposed, or its written form and host. */
const checkUrl = (
  url: string,
  where: string,
):
  | { readonly ok: true; readonly href: string; readonly host: string }
  | { readonly ok: false; readonly error: string } => {
  if (url.length > MCP_PROPOSAL_LIMITS.url || HIDDEN.test(url)) {
    return { ok: false, error: `${where} is too long or has hidden characters.` };
  }
  const parsed = parseUrl(url);
  if (parsed === undefined) return { ok: false, error: `${where} isn't a URL.` };
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: `${where} must be https.` };
  }
  if (parsed.protocol === "http:" && !LOOPBACK.has(parsed.hostname)) {
    return {
      ok: false,
      error: `${where} must be https; plain http is only for this machine (localhost).`,
    };
  }
  const credential = urlCredential(parsed, where);
  if (credential !== undefined) return { ok: false, error: credential };
  if (parsed.hash !== "") return { ok: false, error: `${where} has a #fragment; leave it out.` };
  return { ok: true, href: parsed.href, host: parsed.host };
};

/** `values` as name/value pairs, or why one can't be written. */
const checkPairs = (
  values: Readonly<Record<string, string>> | undefined,
  kind: "env" | "header",
  errors: Array<string>,
): ReadonlyArray<McpProposalPair> => {
  const pairs = Object.entries(values ?? {}).map(([name, value]) => ({ name, value }));
  const max = kind === "env" ? MCP_PROPOSAL_LIMITS.env : MCP_PROPOSAL_LIMITS.headers;
  if (pairs.length > max) errors.push(`At most ${max} ${kind === "env" ? "env vars" : "headers"}.`);
  for (const { name, value } of pairs) {
    const label = kind === "env" ? `Env var ${name}` : `Header ${name}`;
    if (!(kind === "env" ? ENV_NAME : HEADER_NAME).test(name)) {
      errors.push(`${label} isn't a valid ${kind === "env" ? "variable" : "header"} name.`);
    } else if (HIDDEN.test(value) || value.length > MCP_PROPOSAL_LIMITS.value) {
      errors.push(`${label}'s value has hidden characters or is too long.`);
    } else if (secretName(name) || secretValue(value)) {
      errors.push(`${label} looks like a credential. ${REFUSE_SECRET}`);
    } else if (kind === "env" && LOADER_ENV.test(name)) {
      errors.push(
        `Env var ${name} changes which program runs or what it loads, so it can't be proposed.`,
      );
    }
  }
  return pairs;
};

/** The arguments' problems: hidden characters, credential flags and key-shaped values. */
const checkArgs = (args: ReadonlyArray<string>, errors: Array<string>) => {
  if (args.length > MCP_PROPOSAL_LIMITS.args)
    errors.push(`At most ${MCP_PROPOSAL_LIMITS.args} arguments.`);
  args.forEach((arg, i) => {
    const label = `Argument ${i + 1}`;
    const [flag, attached] =
      arg.startsWith("-") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), true]
        : [arg, false];
    if (HIDDEN.test(arg) || arg.length > MCP_PROPOSAL_LIMITS.value) {
      errors.push(`${label} has hidden characters or is too long.`);
    } else if (SECRET_FLAG.test(flag) && (attached || i + 1 < args.length)) {
      errors.push(`${label} (${flag}) passes a credential. ${REFUSE_SECRET}`);
    } else if (secretValue(arg)) {
      errors.push(`${label} looks like a credential. ${REFUSE_SECRET}`);
    } else {
      const url = /^https?:\/\//i.test(arg) ? parseUrl(arg) : undefined;
      const credential = url === undefined ? undefined : urlCredential(url, label);
      if (credential !== undefined) errors.push(credential);
    }
  });
};

/** `[mcp_servers.<name>]` in Codex's config, or the scope `claude mcp add-json` writes. */
const whereFor = (target: McpTarget, scope: McpProposalScope, name: string, folder: string) =>
  target === "codex"
    ? `Codex's config.toml, [mcp_servers.${name}]: every project, Gram's own Codex home included`
    : scope === "user"
      ? "Claude Code's user config (claude mcp add-json --scope user): every project"
      : `${folder.replace(/\/$/, "")}/.mcp.json (claude mcp add-json --scope project): this project, shared with whoever has the repo`;

/** A token the shell would read as one word, quoted only where it has to be. */
export const shellWord = (word: string): string =>
  word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;

/** `command` and `args` as one line a shell would run the same. */
export const commandLineOf = (command: string, args: ReadonlyArray<string> = []): string =>
  [command, ...args].map(shellWord).join(" ");

export type McpProposalCheck =
  | { readonly ok: true; readonly proposal: McpServerProposal }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/**
 * `input` checked whole before any card: a valid, unreserved name, targets that can run it at the
 * scope asked, and no credential anywhere in it. A remote URL is written as `URL` reads it, so the
 * card shows what is written.
 */
export const checkMcpServerProposal = (
  input: McpServerProposeInput,
  reserved: ReadonlyArray<string> = [],
): McpProposalCheck => {
  const errors: Array<string> = [];
  const name = input.name;
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    errors.push("The name uses letters, digits, dashes or underscores, up to 64.");
  } else if (reserved.some((taken) => taken.toLowerCase() === name.toLowerCase())) {
    errors.push(`${name} is Gram's own server; pick another name.`);
  }
  const reason = input.reason.replace(/\s+/g, " ").trim();
  if (reason === "") errors.push("Say why in reason; the card shows it.");
  if (HIDDEN.test(input.reason)) errors.push("The reason has hidden characters.");
  const targets = [...new Set(input.targets)];
  const scope = input.scope ?? "user";
  const server = input.server;
  let config: McpServerConfig = server;
  if (server.type === "stdio") {
    const command = server.command;
    if (command.trim() !== command || command === "")
      errors.push("The command has spaces around it.");
    if (HIDDEN.test(command) || command.length > MCP_PROPOSAL_LIMITS.value) {
      errors.push("The command has hidden characters or is too long.");
    } else if (secretValue(command)) {
      errors.push(`The command looks like a credential. ${REFUSE_SECRET}`);
    } else if (command.includes("/") && !command.startsWith("/")) {
      // Found from each session's own folder, so the card couldn't say which file runs.
      errors.push("The command is a relative path: use an absolute path or a program on PATH.");
    }
    checkArgs(server.args ?? [], errors);
    checkPairs(server.env, "env", errors);
  } else {
    const url = checkUrl(server.url, "The URL");
    if (!url.ok) errors.push(url.error);
    else config = { ...server, url: url.href };
    checkPairs(server.headers, "header", errors);
    if (server.type === "sse" && targets.includes("codex")) {
      errors.push(
        "Codex connects over streamable HTTP only, not SSE: use http, or target Claude Code alone.",
      );
    }
  }
  if (scope === "project" && targets.includes("codex")) {
    errors.push(
      "Codex keeps MCP servers for every project only: use scope user, or target Claude Code alone.",
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    proposal: { name, config, targets, scope, replace: input.replace === true, reason },
  };
};

/** `server` as the card shows one a target already has. */
export const existingOf = (server: ConfiguredServer): McpProposalExisting => ({
  transport: server.transport,
  scope: server.scope,
  ...(server.url === undefined ? {} : { url: server.url }),
  ...(server.command === undefined
    ? {}
    : { commandLine: commandLineOf(server.command, server.args) }),
  carriesValues: server.carriesValues,
});

/** `values` as the card lists them, in the order given. */
const pairsOf = (values: Readonly<Record<string, string>> | undefined) =>
  Object.entries(values ?? {}).map(([key, value]) => ({ name: key, value }));

/** What the user does after an approval to finish: a remote server's sign-in, in each target. */
const signInNotes = (proposal: McpServerProposal): ReadonlyArray<string> => {
  if (proposal.config.type === "stdio") return [];
  const steps = proposal.targets.map((target) =>
    target === "claude"
      ? "in Claude Code, run /mcp and choose Authenticate"
      : `in Codex, run codex mcp login ${proposal.name}`,
  );
  return [`If the server asks you to sign in: ${steps.join("; ")}. Gram never sees the token.`];
};

/** The card for a checked `proposal`, written in `folder`, over what each target has now. */
export const mcpServerProposalCard = (
  proposal: McpServerProposal,
  folder: string,
  existing: Partial<Record<McpTarget, ConfiguredServer>>,
): McpServerProposalCard => {
  const { name, config, scope } = proposal;
  const targets = proposal.targets.map((target) => {
    const there = existing[target];
    return {
      target,
      label: MCP_TARGET_LABEL[target],
      where: whereFor(target, scope, name, folder),
      ...(there === undefined ? {} : { replaces: existingOf(there) }),
    };
  });
  const notes = signInNotes(proposal);
  return {
    name,
    action: targets.some((t) => t.replaces !== undefined) ? "replace" : "add",
    transport: config.type,
    ...(config.type === "stdio"
      ? {
          command: config.command,
          args: [...(config.args ?? [])],
          commandLine: commandLineOf(config.command, config.args),
          ...(Object.keys(config.env ?? {}).length === 0 ? {} : { env: pairsOf(config.env) }),
        }
      : {
          url: config.url,
          host: new URL(config.url).host,
          ...(Object.keys(config.headers ?? {}).length === 0
            ? {}
            : { headers: pairsOf(config.headers) }),
        }),
    scope,
    scopeText:
      scope === "user" ? "User: you, in every project" : "Project: this repository's .mcp.json",
    targets,
    reason: proposal.reason,
    ...(notes.length === 0 ? {} : { notes }),
  };
};

/** The card's one-line summary. */
export const mcpServerProposalSummary = (card: McpServerProposalCard): string => {
  const verb = card.action === "replace" ? "Replace" : "Add";
  const kind =
    card.transport === "stdio"
      ? "a program run on this machine"
      : `a remote server at ${card.host ?? ""}`;
  const to = card.targets.map((t) => t.label).join(" and ");
  return `${verb} the MCP server “${card.name}”, ${kind}, in ${to}.`;
};
