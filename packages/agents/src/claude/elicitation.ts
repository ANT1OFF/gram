// An MCP server's permission prompt in a Claude session (the SDK's `onElicitation`), as an
// approval card. Without a handler the SDK declines every one, which is what a computer-use
// server's "may I use this app" gets. Claude Code passes on neither the prompt's `_meta` nor the
// answer's, so a grant for the session is kept here, by server and message.

import { RequestId, type ApprovalRequest, type RequestAnswer } from "@gram/contracts";
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import { promptAnswer, promptScopes, promptSubject, type McpPrompt } from "../mcp-elicitation.ts";

const promptOf = (request: ElicitationRequest): McpPrompt => ({
  serverName: request.serverName,
  message: request.message,
  mode: request.mode ?? "form",
  ...(request.requestedSchema === undefined ? {} : { requestedSchema: request.requestedSchema }),
  adapterRemembers: true,
});

/** What a session grant is remembered by: the same server asking the same thing. */
export const elicitationKey = (request: ElicitationRequest): string =>
  `${request.serverName}\u0000${request.message}`;

export const ELICITATION_DECLINED: ElicitationResult = { action: "decline" };

/**
 * The card for the prompt, or `undefined` where a yes or no can't answer it. Under an outward
 * gate at `all` (`gated`) it offers the one use only. Never "always": nothing here outlives the
 * session.
 */
export const elicitationCard = (
  request: ElicitationRequest,
  requestId: string,
  gated: boolean,
): ApprovalRequest | undefined => {
  const prompt = promptOf(request);
  const scopes = promptScopes(prompt, gated).filter((scope) => scope !== "always");
  if (scopes.length === 0) return undefined;
  const subject = promptSubject(prompt);
  const description = [request.title, request.message, request.description]
    .map((part) => part?.trim())
    .filter(
      (part, index, parts) => part !== undefined && part !== "" && parts.indexOf(part) === index,
    )
    .join("\n");
  return {
    kind: "approval",
    id: RequestId.make(requestId),
    toolName: `mcp__${request.serverName}__elicitation`,
    displayName: request.displayName ?? subject ?? request.serverName,
    input: { server: request.serverName, ...(subject === undefined ? {} : { app: subject }) },
    ...(description === "" ? {} : { description }),
    suggestions: [],
    scopes,
  };
};

/** The SDK's answer for the user's, and whether the session should remember the grant. */
export const elicitationResult = (
  request: ElicitationRequest,
  answer: RequestAnswer,
  gated: boolean,
): { readonly result: ElicitationResult; readonly remember: boolean } => {
  const allow = answer.kind === "approval" && answer.decision === "allow";
  const scope = answer.kind === "approval" && answer.scope === "session" ? "session" : "once";
  const { action, content, persist } = promptAnswer(promptOf(request), allow, scope, gated);
  return {
    result: action === "accept" ? { action, content: content ?? {} } : ELICITATION_DECLINED,
    remember: action === "accept" && persist === "session",
  };
};

/** The answer for a prompt the session already granted: the one use, again. */
export const elicitationGranted = (request: ElicitationRequest): ElicitationResult =>
  elicitationResult(request, { kind: "approval", decision: "allow", scope: "once" }, true).result;
