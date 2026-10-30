import {
  THREAD_ERROR_TEXT_MAX,
  type AgentFailure,
  type AgentKind,
  type AgentUnavailable,
  type ThreadError,
  type TurnId,
} from "@gram/contracts";
import { redactText } from "../logging/redact.ts";

/** What the sentence for a failure may name: the thread's model, and whether it runs on a gateway. */
export interface FailureContext {
  readonly model?: string | undefined;
  /** The thread's agent, which decides whether it should have gone through a gateway at all. */
  readonly agent?: AgentKind | undefined;
  /** The thread runs on a gateway profile, so "the gateway" is who answered. */
  readonly gateway: boolean;
  /**
   * The gateway profile's address, so a refusal from somewhere else isn't blamed on its key. Only
   * its host is compared, and nothing of it is shown.
   */
  readonly gatewayURL?: string | undefined;
}

/** A failure the adapter couldn't classify, which is also what an agent with no mapping reports. */
export const UNKNOWN_FAILURE: AgentFailure = { kind: "unknown", retryable: true };

/** A turn Gram stopped because its agent kept retrying past the deadline. */
export const RETRIES_EXHAUSTED: AgentFailure = {
  kind: "network",
  code: "retriesExhausted",
  retryable: true,
};

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** The agent's own words, redacted and on one line, for the one kind that has no sentence of ours. */
const excerpt = (detail: string, room: number): string =>
  clip(redactText(detail).replaceAll(/\s+/g, " ").trim(), room);

const AGENT_NAMES: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
};

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // Not a URL: a profile saved with a typo, or a fragment of the agent's message.
    return undefined;
  }
};

/**
 * The host a refused request went to, when the agent's message names its URL, as Codex's
 * `unexpected status 401 …, url: https://…` does. A host is all it takes, never a path or query.
 */
export const requestHost = (detail: string): string | undefined => {
  const named = /\burl:\s*(https?:\/\/[^\s,;)"'<>]+)/i.exec(detail);
  return named === null ? undefined : hostOf(named[1]!);
};

/** A refusal from a different host must not be blamed on an explicitly selected gateway key. */
const offGateway = (
  detail: string,
  context: FailureContext,
): { readonly host: string | undefined } | undefined => {
  const host = requestHost(detail);
  if (!context.gateway) return undefined;
  const gatewayHost = context.gatewayURL === undefined ? undefined : hostOf(context.gatewayURL);
  return host !== undefined && gatewayHost !== undefined && host !== gatewayHost
    ? { host }
    : undefined;
};

/** The sentence for a sign-in refused by something other than the thread's gateway. */
const offGatewayText = (
  off: { readonly host: string | undefined },
  context: FailureContext,
  status: string,
): string => {
  const name = context.agent === undefined ? "The agent" : AGENT_NAMES[context.agent];
  const where = off.host === undefined ? "the provider" : off.host;
  return `${name} ran without the gateway: its request went to ${where}, not the thread's gateway, and was refused${status}. The gateway key isn't what failed, so Settings won't fix it; report it.`;
};

/**
 * Gram's sentence for a failure, as the transcript, the sidebar and the orchestrator's ledger
 * show it. Only an `unknown` failure quotes the agent's message, redacted and clipped: every other
 * kind is told in our words, which name nothing the request carried.
 */
export const failureText = (
  failure: AgentFailure,
  detail: string,
  context: FailureContext,
): string => {
  const status = failure.httpStatus === undefined ? "" : ` (HTTP ${failure.httpStatus})`;
  const model = context.model === undefined ? "this model" : context.model;
  const where = context.gateway ? "The gateway" : "The provider";
  const sentence = ((): string => {
    switch (failure.kind) {
      case "gatewayRefused":
        return `Gateway refused the request: no deployment supports this request${status}. Sending it again won't help; try another model.`;
      case "costGuard":
        return failure.code === "sessionBudgetExceeded"
          ? "Codex stopped: this session's budget is spent."
          : context.gateway
            ? `The gateway disabled this key over its spending limit${status}. Check your gateway's billing and key limits.`
            : `The provider refused the request over billing or a spending limit${status}.`;
      case "rateLimit":
        return failure.retryable
          ? `${where} is rate limiting requests${status}. Try again in a moment.`
          : `The usage limit is reached${status}. It resets on the provider's schedule.`;
      case "auth": {
        const off = offGateway(detail, context);
        if (off !== undefined) return offGatewayText(off, context, status);
        return context.gateway
          ? `The gateway didn't accept the key${status}. Check it in Settings → Gateways.`
          : `The agent's sign-in or key was refused${status}.`;
      }
      case "modelUnavailable":
        return `${where} can't serve ${model}${status}. Pick another model.`;
      case "network":
        return failure.code === RETRIES_EXHAUSTED.code
          ? "The agent kept retrying without reaching the model API, so Gram stopped the turn. Send again once the connection is back."
          : `Couldn't reach the model API${status}. Check the connection and try again.`;
      case "unknown": {
        const lead = `The turn failed${status}: `;
        return `${lead}${excerpt(detail, THREAD_ERROR_TEXT_MAX - lead.length)}`;
      }
    }
  })();
  return clip(sentence, THREAD_ERROR_TEXT_MAX);
};

/** The error a failed turn leaves on its thread. */
export const threadError = (
  failure: AgentFailure,
  detail: string,
  context: FailureContext,
  at: number,
  turnId?: TurnId,
): ThreadError => ({
  ...failure,
  text: failureText(failure, detail, context),
  ...(turnId === undefined ? {} : { turnId }),
  at,
});

const isAuthProblem = (error: AgentUnavailable): boolean =>
  error.reason === "not-logged-in" ||
  error.reason === "api-key-auth" ||
  error.reason === "auth-status-failed";

/** Preserve the selected agent's own startup/authentication advice. */
export const unavailableMessage = (error: AgentUnavailable): string => error.message;

/** The error an agent that couldn't start leaves: `AgentUnavailable`'s message is about starting. */
export const unavailableError = (error: AgentUnavailable, at: number): ThreadError => {
  const auth = isAuthProblem(error);
  const lead = `${AGENT_NAMES[error.agent]} couldn't start: `;
  return {
    kind: auth ? "auth" : "unknown",
    retryable: !auth,
    ...(error.reason === undefined ? {} : { code: error.reason }),
    text: `${lead}${excerpt(unavailableMessage(error), THREAD_ERROR_TEXT_MAX - lead.length)}`,
    at,
  };
};

/** The error a thread whose folder is gone leaves when its agent can't start there. */
export const missingFolderError = (text: string, at: number): ThreadError => ({
  kind: "unknown",
  retryable: false,
  text: excerpt(text, THREAD_ERROR_TEXT_MAX),
  at,
});

/**
 * The agent's code as a log field: its own enum names are safe to log, anything else is not
 * logged at all.
 */
export const loggableCode = (code: string | undefined): string =>
  code !== undefined && /^[A-Za-z][A-Za-z_-]{0,47}$/.test(code) ? code : "";
