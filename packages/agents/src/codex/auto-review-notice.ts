import type { AgentEvent } from "@gram/contracts";
import type { GuardianApprovalReviewAction } from "./protocol/v2/GuardianApprovalReviewAction.ts";
import type { ItemGuardianApprovalReviewCompletedNotification } from "./protocol/v2/ItemGuardianApprovalReviewCompletedNotification.ts";

const clip = (text: string, max = 120): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const code = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

const reviewedAction = (action: GuardianApprovalReviewAction): string => {
  switch (action.type) {
    case "command":
      return code(clip(action.command));
    case "execve":
      return code(clip([action.program, ...action.argv.slice(1)].join(" ")));
    case "writeStdin":
      return "input to a running command";
    case "applyPatch":
      return action.files.length === 1
        ? "an edit to 1 file"
        : `an edit to ${action.files.length} files`;
    case "networkAccess":
      return `network access to ${action.host}`;
    case "mcpToolCall":
      return `${action.toolTitle ?? action.toolName} on ${action.connectorName ?? action.server}`;
    case "requestPermissions":
      return "more permissions";
    default:
      return "a request";
  }
};

/**
 * The notice for a finished automatic review, or none: an approval ran as asked, and an aborted
 * review went with its turn. A denial and a review that couldn't finish didn't run, and the agent
 * was told so. The reviewer's rationale is model text, so it is clipped like the command.
 */
export const autoReviewNotice = (
  p: Pick<ItemGuardianApprovalReviewCompletedNotification, "review" | "action">,
): AgentEvent | undefined => {
  const what = reviewedAction(p.action);
  const why = p.review.rationale?.trim();
  switch (p.review.status) {
    case "denied":
      return {
        type: "notice",
        level: "warning",
        message: `Codex's auto-review denied ${what}${why ? `: ${clip(why, 300)}` : "."}`,
      };
    case "timedOut":
      return {
        type: "notice",
        level: "warning",
        message: `Codex's auto-review timed out on ${what}, so it didn't run.`,
      };
    default:
      return undefined;
  }
};
