import { type GatewayAgentTool, type LaunchChecks, type LaunchTool } from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";

/** Whether `version` is below `than`, comparing `MAJOR.MINOR.PATCH` numerically. */
export function isOlderVersion(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

export interface LaunchIssue {
  /** Stable per problem, so a dismissal only hides problems already shown. */
  readonly id: string;
  /** One sentence; `backticks` mark a command. */
  readonly text: string;
  /** An outdated agent, whose CLI the line offers to update. */
  readonly update?: GatewayAgentTool | undefined;
}

/**
 * What to tell the user about the launch checks, most important first. An unreadable Claude sign-in
 * status isn't reported: Diagnostics shows it, and a wrong alarm would be worse.
 */
export function launchIssues(checks: LaunchChecks): LaunchIssue[] {
  const found = (tool: LaunchTool) => checks.tools.find((t) => t.tool === tool)?.found === true;
  const issues: LaunchIssue[] = [];
  const claudeUnusable = checks.tools.find((t) => t.tool === "claude")?.unusable;
  // With neither agent installed nothing can start, whichever one threads or settings name.
  const noAgent = !found("claude") && !found("codex");
  const usesClaude =
    !noAgent &&
    (checks.localAgentsInUse === undefined || checks.localAgentsInUse.includes("claude"));

  if (noAgent) {
    issues.push({
      id: "agents-missing",
      text: "Neither Claude Code nor Codex is installed, so no thread can start. Install one, sign in, then re-check.",
    });
  } else if (usesClaude && !found("claude")) {
    issues.push({
      id: "claude-missing",
      text: "Claude Code isn't installed, so Claude threads can't start. Install it, then re-check.",
    });
  } else if (usesClaude && claudeUnusable !== undefined) {
    // Signing in wouldn't help, so the sign-in state waits until a thread can start.
    issues.push({ id: "claude-unusable", text: claudeUnusable });
  } else if (usesClaude && checks.claudeSignIn === "notSignedIn") {
    issues.push({
      id: "claude-signed-out",
      text: "Claude Code isn't signed in. Run `claude` in a terminal to sign in.",
    });
  } else if (usesClaude && checks.claudeSignIn === "apiKey") {
    issues.push({
      id: "claude-api-key",
      text: "Claude Code is using an API key. Gram needs your subscription: run `claude` and sign in.",
    });
  } else if (usesClaude && checks.claudeSignIn === "thirdParty") {
    issues.push({
      id: "claude-third-party",
      text: "Claude Code is set up for another API provider. Claude threads need your subscription sign-in.",
    });
  }

  if (found("codex") && checks.localAgentsInUse?.includes("codex")) {
    if (checks.codexSignIn === "notSignedIn")
      issues.push({
        id: "codex-signed-out",
        text: "Codex isn't signed in. Run `codex login` with your ChatGPT account, then re-check.",
      });
    if (checks.codexSignIn === "apiKey")
      issues.push({
        id: "codex-api-key",
        text: "Codex is using an API key, billed separately from your subscription. Run `codex login` to use ChatGPT.",
      });
  }

  if (!found("git")) {
    issues.push({
      id: "git-missing",
      text: "git isn't installed. Worktrees, diffs and PR state are off.",
    });
  }

  if (!found("gh")) {
    issues.push({ id: "gh-missing", text: "gh isn't installed. PR badges and reviews are off." });
  } else if (!checks.ghSignedIn) {
    issues.push({
      id: "gh-signed-out",
      text: "gh isn't signed in. Run `gh auth login` to turn on PR badges and reviews.",
    });
  }

  // Only the agents the user relies on: a Claude-only user isn't told about Codex.
  for (const agent of checks.agentsInUse ?? []) {
    const tool = checks.tools.find((t) => t.tool === agent);
    if (tool === undefined || (noAgent && !tool.found)) continue;
    const name = agentLabel(agent);
    const command = tool.upgradeCommand;
    if (!tool.found) {
      issues.push({
        id: `${agent}-missing`,
        text: `${name} isn't installed, so ${name} threads can't start. ${
          command === undefined ? "Install it" : `Install it with \`${command}\``
        }, then re-check.`,
      });
    } else if (
      tool.version !== undefined &&
      tool.testedVersion !== undefined &&
      isOlderVersion(tool.version, tool.testedVersion)
    ) {
      issues.push({
        // Per installed version, so dismissing one doesn't hide a later, different skew.
        id: `${agent}-outdated-${tool.version}`,
        text: `${name} ${tool.version} is older than the ${tool.testedVersion} Gram is tested with. Some features may not work.${
          command === undefined ? "" : ` Upgrade with \`${command}\`.`
        }`,
        update: agent,
      });
    }
  }

  return issues;
}
