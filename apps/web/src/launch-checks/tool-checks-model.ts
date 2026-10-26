import {
  type ClaudeSignIn,
  type CodexSignIn,
  type LaunchChecks,
  type ToolCheck,
} from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";

import { isOlderVersion } from "./issues";

/** The agents Gram runs itself, whose CLIs the launch checks look for. */
export type Harness = "claude" | "codex";
export const HARNESSES: readonly Harness[] = ["claude", "codex"];

interface AgentTrouble {
  /** `error` when its threads can't start, `warning` when they start with something off. */
  readonly level: "error" | "warning";
  /** A few words beside the name, such as "not signed in". */
  readonly summary: string;
  /** The whole story, one or two sentences; `backticks` mark a command. */
  readonly detail: string;
  /** A command that fixes it, offered to copy. */
  readonly fix?: string;
}

/** One agent's row on Settings → Agents: healthy rows carry no `trouble`, and show no status. */
export interface AgentStatus {
  readonly agent: Harness;
  /** The installed version, when it could be read. */
  readonly version?: string;
  /** Muted words beside the version, for something off with an agent nobody relies on. */
  readonly note?: string;
  readonly trouble?: AgentTrouble;
}

const CLAUDE_SIGN_IN_TROUBLE: Partial<Record<ClaudeSignIn, AgentTrouble>> = {
  notSignedIn: {
    level: "error",
    summary: "not signed in",
    detail: "Claude Code isn't signed in, so Claude threads can't start. Run `claude` to sign in.",
    fix: "claude",
  },
  apiKey: {
    level: "warning",
    summary: "using an API key",
    detail:
      "Claude Code is using an API key. Gram needs your subscription: run `claude` and sign in.",
    fix: "claude",
  },
  thirdParty: {
    level: "warning",
    summary: "another API provider",
    detail:
      "Claude Code is set up for another API provider. Claude threads need your subscription sign-in.",
  },
};

function claudeStatus(tool: ToolCheck | undefined, checks: LaunchChecks): AgentStatus {
  if (tool === undefined || !tool.found) {
    return {
      agent: "claude",
      trouble: {
        level: "error",
        summary: "not installed",
        detail: "Claude Code isn't on the login-shell PATH, so Claude threads can't start.",
      },
    };
  }
  const version = tool.version === undefined ? {} : { version: tool.version };
  if (tool.unusable !== undefined) {
    return {
      agent: "claude",
      ...version,
      trouble: { level: "error", summary: "can't start threads", detail: tool.unusable },
    };
  }
  // An unreadable sign-in isn't trouble: Diagnostics says so, and a wrong alarm would be worse.
  const trouble = CLAUDE_SIGN_IN_TROUBLE[checks.claudeSignIn];
  return { agent: "claude", ...version, ...(trouble === undefined ? {} : { trouble }) };
}

function gatewayAgentStatus(
  agent: "codex",
  tool: ToolCheck | undefined,
  inUse: boolean,
): AgentStatus {
  const name = agentLabel(agent);
  const fix = tool?.upgradeCommand === undefined ? {} : { fix: tool.upgradeCommand };
  if (tool === undefined || !tool.found) {
    // Not installed is only trouble for someone who relies on it.
    if (!inUse) return { agent, note: "not installed" };
    return {
      agent,
      trouble: {
        level: "error",
        summary: "not installed",
        detail: `${name} isn't on the login-shell PATH, so ${name} threads can't start.`,
        ...fix,
      },
    };
  }
  const version = tool.version === undefined ? {} : { version: tool.version };
  if (
    tool.version !== undefined &&
    tool.testedVersion !== undefined &&
    isOlderVersion(tool.version, tool.testedVersion)
  ) {
    // Like the launch banner, an old version is only trouble for someone who relies on it.
    if (!inUse) return { agent, ...version, note: `older than ${tool.testedVersion}` };
    return {
      agent,
      ...version,
      trouble: {
        level: "warning",
        summary: `older than ${tool.testedVersion}`,
        detail: `${name} ${tool.version} is older than the ${tool.testedVersion} Gram is tested with. Some features may not work.`,
        ...fix,
      },
    };
  }
  return { agent, ...version };
}

/**
 * A row per harness, in `HARNESSES` order, with trouble only where there is some.
 */
export function agentStatuses(checks: LaunchChecks): AgentStatus[] {
  const tool = (agent: Harness) => checks.tools.find((t) => t.tool === agent);
  const inUse = new Set(checks.agentsInUse ?? []);
  return HARNESSES.map((agent) => {
    if (agent === "claude") {
      const status = claudeStatus(tool(agent), checks);
      if (
        status.trouble !== undefined &&
        checks.localAgentsInUse !== undefined &&
        !checks.localAgentsInUse.includes("claude")
      ) {
        const { trouble, ...rest } = status;
        return { ...rest, note: trouble.summary };
      }
      return checks.claudeSignIn === "unknown" &&
        tool(agent)?.found === true &&
        status.trouble === undefined
        ? { ...status, note: "sign-in unknown" }
        : status;
    }
    const status = gatewayAgentStatus(agent, tool(agent), inUse.has(agent));
    if (agent !== "codex" || tool(agent)?.found !== true) return status;
    const signIn = checks.codexSignIn ?? "unknown";
    const trouble = CODEX_SIGN_IN_TROUBLE[signIn];
    if (trouble !== undefined && checks.localAgentsInUse?.includes("codex")) {
      return {
        agent,
        ...(status.version === undefined ? {} : { version: status.version }),
        trouble,
      };
    }
    return status.trouble === undefined && status.note === undefined
      ? { ...status, note: CODEX_SIGN_IN[signIn] }
      : status;
  });
}

const CODEX_SIGN_IN: Readonly<Record<CodexSignIn, string>> = {
  signedIn: "ChatGPT login",
  notSignedIn: "not signed in",
  apiKey: "using an API key",
  unknown: "sign-in unknown",
};
const CODEX_SIGN_IN_TROUBLE: Partial<Record<CodexSignIn, AgentTrouble>> = {
  notSignedIn: {
    level: "error",
    summary: "not signed in",
    detail: "Codex isn't signed in. Run `codex login` with your ChatGPT account, then re-check.",
    fix: "codex login",
  },
  apiKey: {
    level: "warning",
    summary: "using an API key",
    detail:
      "Codex is using an API key, billed separately from your subscription. Run `codex login` to use ChatGPT.",
    fix: "codex login",
  },
};

const CLAUDE_SIGN_IN: Readonly<Record<ClaudeSignIn, string>> = {
  signedIn: "signed in",
  notSignedIn: "not signed in",
  apiKey: "using an API key",
  thirdParty: "using another API provider",
  unknown: "couldn't tell",
};

/** Diagnostics' line for one tool: where it is, its version, and its sign-in where it has one. */
export function toolSummary(tool: ToolCheck, checks: LaunchChecks): string {
  const parts = [
    tool.found
      ? `${tool.version ?? "version unknown"}${tool.path ? ` at ${tool.path}` : ""}`
      : "not found on the login-shell PATH",
  ];
  if (tool.found && tool.tool === "claude") parts.push(CLAUDE_SIGN_IN[checks.claudeSignIn]);
  if (tool.found && tool.tool === "codex")
    parts.push(CODEX_SIGN_IN[checks.codexSignIn ?? "unknown"]);
  if (tool.found && tool.tool === "gh")
    parts.push(checks.ghSignedIn ? "signed in" : "not signed in");
  if (tool.testedVersion !== undefined) parts.push(`tested with ${tool.testedVersion}`);
  return parts.join(", ");
}

/**
 * Diagnostics' line under Codex: what its gateway threads read from the user's own Codex setup, or
 * `undefined` when that's nothing.
 */
export function codexInheritsSummary(checks: LaunchChecks): string | undefined {
  const inherits = checks.codexGatewayInherits;
  if (inherits === undefined) return undefined;
  const parts = [
    ...(inherits.skills.length === 0 ? [] : [`skills in ${inherits.skills.join(" and ")}`]),
    ...(inherits.instructions === undefined ? [] : [`instructions from ${inherits.instructions}`]),
  ];
  return parts.length === 0 ? undefined : `gateway threads use your ${parts.join(", and ")}`;
}
