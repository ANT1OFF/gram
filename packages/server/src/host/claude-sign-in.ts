import type { AgentHost } from "@gram/agents";
import type {
  AgentUnavailable,
  AgentUnavailableReason,
  ClaudeSignIn,
  HostId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

const BY_REASON: Partial<Record<AgentUnavailableReason, ClaudeSignIn>> = {
  "not-logged-in": "notSignedIn",
  "api-key-auth": "apiKey",
  "third-party-provider": "thirdParty",
};

/** What a failed readiness check says about the sign-in; anything but an auth answer is unknown. */
export const signInOfUnavailable = (error: AgentUnavailable): ClaudeSignIn =>
  (error.reason === undefined ? undefined : BY_REASON[error.reason]) ?? "unknown";

/**
 * This machine's Claude Code sign-in, from the agent's own fresh readiness check (its
 * `claude auth status`). Only the classification leaves: never the command's output, and nothing
 * here reads a credential.
 */
export const claudeSignInOf = (claude: AgentHost): Effect.Effect<ClaudeSignIn> =>
  claude.checkWorkspaceSwitch === undefined
    ? Effect.succeed("unknown")
    : claude.checkWorkspaceSwitch.pipe(
        Effect.as("signedIn" as const),
        Effect.catch((error) => Effect.succeed(signInOfUnavailable(error))),
      );

/**
 * The line the Sign in button runs on a machine: the user's own CLI, which opens the sign-in page
 * (or prints its link, to open here) and ends once it is done. Gram never sees what it stores.
 */
export const CLAUDE_SIGN_IN_COMMAND = "claude auth login --claudeai";

/** The terminal the Sign in button opens: on `hostId`, in that machine's home folder. */
export const machineSignInTerminal = (hostId: HostId) => ({
  hostId,
  // Expanded by the machine's own host, to its own home.
  cwd: "~",
  command: CLAUDE_SIGN_IN_COMMAND,
  script: "Sign in to Claude",
});
