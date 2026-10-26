import type { AgentKind, SlashCommand } from "@gram/contracts";

/**
 * Slash commands Gram answers itself, and the ones it explains instead of sending. A
 * terminal agent's own `/clear`, `/model` or `/mcp` acts on a terminal Gram doesn't show
 * (Claude's `/clear` wipes the agent's context while the thread keeps showing it), or isn't a
 * command at all outside its TUI (Codex sends them to the model as text). So those
 * names do what Gram has for them, and a TUI-only command typed anyway gets a note before
 * anything is sent. The rest go to the agent, which reports the ones it runs.
 */

/** What a Gram-handled command does. */
export type NativeAction =
  | "newThread"
  | "pickModel"
  | "pickEffort"
  | "pickMode"
  | "rename"
  | "fork"
  | "findThread"
  | "addDirectory"
  | "closeThread"
  | "connectors"
  | "agentSettings"
  | "help";

/** A row of the slash menu: the agent's command, or one Gram handles. */
export type MenuCommand = SlashCommand & { readonly action?: NativeAction };

interface NativeSpec {
  readonly name: string;
  readonly action: NativeAction;
  readonly description: string;
  readonly argumentHint?: string;
  /** The names each agent's terminal uses for it too. */
  readonly aliases?: Partial<Record<AgentKind, ReadonlyArray<string>>>;
  /** Only for these agents; every agent when left out. */
  readonly agents?: ReadonlyArray<AgentKind>;
  /** Agents whose own command does it right when given arguments, so it gets those. */
  readonly agentTakesArgs?: ReadonlyArray<AgentKind>;
}

const NATIVE: ReadonlyArray<NativeSpec> = [
  {
    name: "new",
    action: "newThread",
    description: "Start a new thread in this folder",
    aliases: { claude: ["clear", "reset"], codex: ["clear"] },
  },
  {
    name: "model",
    action: "pickModel",
    description: "Pick the model",
    argumentHint: "[model]",
    aliases: {},
    // Claude's switches the session, and the thread follows it (`PostModelSwitch`), for any id,
    // a model the pickers don't list included.
    agentTakesArgs: ["claude"],
  },
  { name: "effort", action: "pickEffort", description: "Pick the effort" },
  {
    name: "permissions",
    action: "pickMode",
    description: "Pick the permission mode",
    aliases: { codex: ["approvals"] },
  },
  {
    name: "rename",
    action: "rename",
    description: "Rename the thread",
    argumentHint: "[title]",
  },
  { name: "fork", action: "fork", description: "Fork the thread into a new one" },
  {
    name: "resume",
    action: "findThread",
    description: "Find a thread to go back to",
    aliases: {},
  },
  {
    name: "add-dir",
    action: "addDirectory",
    description: "Give the thread a folder outside its checkout",
    argumentHint: "<path>",
    agents: ["claude", "codex"],
  },
  {
    name: "mcp",
    action: "connectors",
    description: "Open Settings → Connectors",
    aliases: {},
  },
  {
    name: "login",
    action: "agentSettings",
    description: "Open Settings → Agents to sign in",
    aliases: {},
  },
  { name: "help", action: "help", description: "Open Settings → Help" },
  {
    name: "exit",
    action: "closeThread",
    description: "Close the thread",
    aliases: { claude: ["quit"], codex: ["quit"] },
  },
];

const TERMINAL: Partial<Record<AgentKind, string>> = {
  claude: "open Claude Code in a terminal",
  codex: "open Codex in a terminal",
};

/** Typed-only commands that do nothing useful in a thread, with what to do instead when there is something. */
const UNAVAILABLE: Partial<Record<AgentKind, Readonly<Record<string, string | null>>>> = {
  claude: {
    agents: "ask Claude to create or edit a subagent in .claude/agents",
    bashes: "background work shows in the thread",
    btw: null,
    bug: null,
    color: null,
    export: null,
    feedback: null,
    focus: null,
    hooks: null,
    ide: null,
    "install-github-app": null,
    logout: null,
    memory: "ask Claude to edit CLAUDE.md",
    plugin: null,
    plugins: null,
    "privacy-settings": null,
    "release-notes": "What's New is under Settings → Help",
    rewind: "edit an earlier message to rewind to it",
    sandbox: null,
    status: null,
    statusline: null,
    tasks: "background work shows in the thread",
    "terminal-setup": null,
    theme: "Settings → Appearance sets Gram's",
    upgrade: null,
    vim: null,
  },
  codex: {
    diff: "the Diff panel shows the thread's changes",
    experimental: null,
    feedback: null,
    init: "ask Codex to write an AGENTS.md",
    logout: null,
    mention: "type @ to mention a file",
    personality: null,
    ps: "background work shows in the thread",
    review: "ask Codex to review the changes",
    skills: "your skills are in this menu",
    status: "the ring beside Send shows the context used",
    statusline: null,
    theme: "Settings → Appearance sets Gram's",
    undo: "edit an earlier message to rewind to it",
  },
};

/**
 * The Gram commands `agent`'s threads have, as menu rows, less the names the agent itself
 * reports: a user's `/help` skill or `/new` command runs, not Gram's.
 */
const natives = (agent: AgentKind, canFork: boolean, reported: readonly SlashCommand[]) => {
  const taken = new Set(reported.flatMap(namesOf));
  return NATIVE.flatMap((spec) => {
    if (spec.agents !== undefined && !spec.agents.includes(agent)) return [];
    if (spec.action === "fork" && !canFork) return [];
    if (taken.has(spec.name)) return [];
    const kept = spec.aliases?.[agent]?.filter((alias) => !taken.has(alias));
    const aliases = kept === undefined || kept.length === 0 ? undefined : kept;
    const command: MenuCommand & { readonly action: NativeAction } = {
      name: spec.name,
      description: spec.description,
      action: spec.action,
      ...(spec.argumentHint === undefined ? {} : { argumentHint: spec.argumentHint }),
      ...(aliases === undefined ? {} : { aliases }),
    };
    return [{ command, agentTakesArgs: spec.agentTakesArgs?.includes(agent) === true }];
  });
};

const namesOf = (command: SlashCommand) => [command.name, ...(command.aliases ?? [])];

/**
 * The thread's slash menu: every command the agent reports, and what Gram handles under the
 * names the agent leaves free. The agent's adapter leaves out its own that Gram does better
 * (Claude's `/clear` and `/model`), so a reported name is always one the agent should run.
 */
export function menuCommands(
  agent: AgentKind,
  reported: readonly SlashCommand[],
  canFork: boolean,
): MenuCommand[] {
  return [...natives(agent, canFork, reported).map((native) => native.command), ...reported];
}

/** For `filterCommands`: of equal matches, the agent's own come before Gram's. */
export const gramLast = (command: MenuCommand): number => (command.action === undefined ? 0 : 1);

/** What sending `text` should do. */
export type Resolution =
  | { readonly kind: "agent" }
  | { readonly kind: "native"; readonly action: NativeAction; readonly args: string }
  | { readonly kind: "unavailable"; readonly note: string };

/** The command a draft opens with: `/name` then, after whitespace, its arguments. */
const commandOf = (text: string) => {
  const match = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match === null ? undefined : { name: match[1]!, args: match[2]?.trim() ?? "" };
};

/**
 * Whether `text` is a command Gram handles, one it explains instead of sending, or anything
 * else, which goes to the agent as typed: a prompt that opens with a path (`/tmp is full`) too.
 */
export function resolveTyped(
  agent: AgentKind,
  text: string,
  reported: readonly SlashCommand[],
  canFork: boolean,
): Resolution {
  const command = commandOf(text);
  if (command === undefined) return { kind: "agent" };
  const { name, args } = command;
  // The agent's own list outranks this file's: a user's command of that name, or a CLI that
  // learned one, runs.
  if (reported.some((c) => namesOf(c).includes(name))) return { kind: "agent" };
  const native = natives(agent, canFork, reported).find((n) => namesOf(n.command).includes(name));
  if (native !== undefined && !(native.agentTakesArgs && args !== "")) {
    return { kind: "native", action: native.command.action, args };
  }
  if (native !== undefined) return { kind: "agent" };
  const unavailable = UNAVAILABLE[agent] ?? {};
  const prompts = agent === "codex" && name.startsWith("prompts:");
  if (!Object.hasOwn(unavailable, name) && !prompts) return { kind: "agent" };
  const instead = prompts
    ? "Codex has dropped custom prompts; make it a skill in ~/.codex/skills"
    : unavailable[name];
  const terminal = TERMINAL[agent];
  return {
    kind: "unavailable",
    note: `/${name} isn't available in Gram threads${
      instead ? `; ${instead}` : terminal ? `; ${terminal}` : ""
    }.`,
  };
}
