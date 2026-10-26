import type { LaunchChecks, LaunchTool } from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";

/**
 * `ready` works; `attention` is installed but needs the user (a sign-in); `missing` is a tool
 * Gram leans on; `optional` is one only some threads need, so its absence isn't a problem.
 */
export type ToolState = "ready" | "attention" | "missing" | "optional";

export interface ToolRow {
  readonly tool: LaunchTool;
  readonly name: string;
  readonly state: ToolState;
  /** The version when ready, else what to do about it; `backticks` mark a command. */
  readonly detail: string;
}

/** The agents Gram runs; one of them signed in is enough. */
const AGENTS: ReadonlySet<LaunchTool> = new Set(["claude", "codex"]);

const TOOLS: ReadonlyArray<Pick<ToolRow, "tool" | "name"> & { optional?: true }> = [
  { tool: "claude", name: agentLabel("claude") },
  { tool: "codex", name: agentLabel("codex") },
  { tool: "git", name: "git" },
  { tool: "gh", name: "GitHub CLI", optional: true },
];

const CLAUDE_ATTENTION: Partial<Record<LaunchChecks["claudeSignIn"], string>> = {
  notSignedIn: "Not signed in. Run `claude` in a terminal to sign in.",
  apiKey: "Using an API key. Run `claude` and sign in with your subscription.",
  thirdParty: "Set up for another API provider. Claude threads need your subscription sign-in.",
  unknown: "Couldn't verify your login. Run `claude auth status --json`, then re-check.",
};

/** How a stranger gets each agent, when the checks name no install command, and signs in after. */
const AGENT_INSTALL: Partial<Record<LaunchTool, { install: string; signIn: string }>> = {
  claude: { install: "npm i -g @anthropic-ai/claude-code", signIn: "claude" },
  codex: { install: "npm i -g @openai/codex", signIn: "codex login" },
};

const CODEX_ATTENTION = {
  notSignedIn: "Not signed in. Run `codex login` with your ChatGPT account, then re-check.",
  apiKey:
    "Using an API key, billed separately from your subscription. Run `codex login` to use ChatGPT.",
  unknown: "Couldn't verify your login. Run `codex login status`, then re-check.",
};

/**
 * The first-run tools check: Claude Code, Codex, git and the GitHub CLI, read from the launch
 * checks and never changed by them. Either agent alone is enough, so the other one missing is
 * `optional`; with neither ready, both say what to do.
 */
export function toolRows(checks: LaunchChecks): ToolRow[] {
  const rows = TOOLS.map(({ optional, ...row }): ToolRow & { optional?: true } => {
    const check = checks.tools.find((t) => t.tool === row.tool);
    if (check?.found !== true) {
      const agent = AGENT_INSTALL[row.tool];
      const install = check?.upgradeCommand ?? agent?.install;
      return {
        ...row,
        ...(optional ? { optional } : {}),
        state: "missing",
        detail:
          install === undefined
            ? "Not found on your login-shell PATH."
            : `Not found. Install it with \`${install}\`${
                agent === undefined ? "" : `, then sign in with \`${agent.signIn}\``
              }.`,
      };
    }
    const attention =
      row.tool === "claude"
        ? CLAUDE_ATTENTION[checks.claudeSignIn]
        : row.tool === "codex" && checks.codexSignIn !== "signedIn"
          ? CODEX_ATTENTION[checks.codexSignIn ?? "unknown"]
          : row.tool === "gh" && !checks.ghSignedIn
            ? "Not signed in. Run `gh auth login`."
            : undefined;
    return attention === undefined
      ? {
          ...row,
          state: "ready",
          detail:
            row.tool === "codex"
              ? `${check.version ?? "Found"}. Signed in using ChatGPT.`
              : (check.version ?? "Found"),
        }
      : { ...row, state: "attention", detail: attention };
  });
  const agentReady = rows.some((row) => AGENTS.has(row.tool) && row.state === "ready");
  return rows.map(({ optional, ...row }) =>
    row.state === "missing" && (optional === true || (agentReady && AGENTS.has(row.tool)))
      ? { ...row, state: "optional" }
      : row,
  );
}

/** Whether Gram can start work: git, and at least one agent signed in. */
export const canStart = (rows: readonly ToolRow[]): boolean =>
  rows.some((row) => AGENTS.has(row.tool) && row.state === "ready") &&
  rows.some((row) => row.tool === "git" && row.state === "ready");
