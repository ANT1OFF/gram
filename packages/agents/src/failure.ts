import { MODEL_NOT_GRANTED, type AgentFailure, type AgentFailureKind } from "@gram/contracts";
import * as Predicate from "effect/Predicate";

const failure = (
  kind: AgentFailureKind,
  retryable: boolean,
  httpStatus: number | undefined,
  code: string | undefined,
): AgentFailure => ({
  kind,
  retryable,
  ...(httpStatus === undefined ? {} : { httpStatus }),
  ...(code === undefined ? {} : { code }),
});

const NO_DEPLOYMENTS = /No deployments available/i;
const COOLING_DOWN = /cooldown_list=\[\s*['"]/;
const KEY_DISABLED = /API key is disabled/i;
const KEY_RESTRICTED = /is restricted for this API key/i;
const NETWORK =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timed? ?out/i;

const gatewayWords = (text: string): boolean =>
  NO_DEPLOYMENTS.test(text) ||
  KEY_DISABLED.test(text) ||
  KEY_RESTRICTED.test(text) ||
  MODEL_NOT_GRANTED.test(text);

/**
 * What an error from the model API means, from its HTTP status and the text around it (the error
 * message, a response body). The gateway's own refusals are recognised by their words first, since
 * their statuses (429, 403) say something else. `code` is the agent's own name for the error.
 */
export const httpFailure = (
  httpStatus: number | undefined,
  text: string,
  code?: string,
): AgentFailure => {
  if (NO_DEPLOYMENTS.test(text)) {
    return COOLING_DOWN.test(text)
      ? failure("rateLimit", true, httpStatus, code)
      : failure("gatewayRefused", false, httpStatus, code);
  }
  if (KEY_DISABLED.test(text)) return failure("costGuard", false, httpStatus, code);
  if (KEY_RESTRICTED.test(text)) return failure("modelUnavailable", false, httpStatus, code);
  if (MODEL_NOT_GRANTED.test(text)) return failure("modelUnavailable", false, httpStatus, code);
  if (httpStatus === undefined) {
    return NETWORK.test(text)
      ? failure("network", true, undefined, code)
      : failure("unknown", true, undefined, code);
  }
  if (httpStatus === 401 || httpStatus === 403) return failure("auth", false, httpStatus, code);
  if (httpStatus === 404) return failure("modelUnavailable", false, httpStatus, code);
  if (httpStatus === 408) return failure("network", true, httpStatus, code);
  if (httpStatus === 429 || httpStatus === 529) return failure("rateLimit", true, httpStatus, code);
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return failure("network", true, httpStatus, code);
  }
  return failure("unknown", httpStatus >= 500, httpStatus, code);
};

const bodyStatus = (text: string): number | undefined => {
  try {
    const body: unknown = JSON.parse(text);
    const error = Predicate.isObject(body) ? body["error"] : undefined;
    const code = Predicate.isObject(error) ? error["code"] : undefined;
    const status = Number(code);
    return Number.isInteger(status) && status >= 400 && status < 600 ? status : undefined;
  } catch {
    return undefined;
  }
};

/** A Codex `TurnError`, as the app-server sends it on `error` and a failed `turn/completed`. */
export interface CodexTurnError {
  readonly message: string;
  readonly codexErrorInfo: unknown;
  readonly additionalDetails: string | null;
}

const CODEX_KINDS: Record<string, readonly [AgentFailureKind, boolean]> = {
  contextWindowExceeded: ["unknown", false],
  sessionBudgetExceeded: ["costGuard", false],
  usageLimitExceeded: ["rateLimit", false],
  rateLimitExceeded: ["rateLimit", true],
  flexUnavailable: ["modelUnavailable", true],
  serverOverloaded: ["rateLimit", true],
  policyCapacityUnavailable: ["rateLimit", true],
  modelNotFound: ["modelUnavailable", false],
  inferenceHookDenied: ["unknown", false],
  cyberPolicy: ["unknown", false],
  misalignmentPolicyViolation: ["unknown", false],
  internalServerError: ["unknown", true],
  unauthorized: ["auth", false],
};

/**
 * A Codex turn error as an `AgentFailure`, from `codexErrorInfo`: its kind, and the upstream status
 * its HTTP variants forward. `gateway` is a session on a Gram gateway profile. A gateway's 429
 * without a deployments message reads as the gateway refusing, not as a rate limit: a bodyless 429
 * alone cannot establish a configured gateway's limiting policy.
 */
export const codexFailure = (error: CodexTurnError, gateway: boolean): AgentFailure => {
  const info = error.codexErrorInfo;
  const text = `${error.message}\n${error.additionalDetails ?? ""}`;
  if (typeof info === "string") {
    const known = CODEX_KINDS[info];
    if (known !== undefined) return failure(known[0], known[1], undefined, info);
    if (info === "badRequest") return httpFailure(400, text, info);
    return httpFailure(bodyStatus(error.message), text, info);
  }
  if (typeof info === "object" && info !== null) {
    const [code, detail] = Object.entries(info)[0] ?? [];
    const status = Predicate.isObject(detail) ? detail["httpStatusCode"] : undefined;
    const httpStatus = typeof status === "number" ? status : undefined;
    if (httpStatus === 429 && gateway && !NO_DEPLOYMENTS.test(text)) {
      return failure("gatewayRefused", false, httpStatus, code);
    }
    if (httpStatus === undefined && code !== undefined && /Stream|Connection/.test(code)) {
      return failure("network", true, undefined, code);
    }
    return httpFailure(httpStatus, text, code);
  }
  return httpFailure(bodyStatus(error.message), text);
};

const CLAUDE_KINDS: Record<string, readonly [AgentFailureKind, boolean]> = {
  authentication_failed: ["auth", false],
  oauth_org_not_allowed: ["auth", false],
  account_on_hold: ["auth", false],
  verification_required: ["auth", false],
  cloud_credential_error: ["auth", false],
  billing_error: ["costGuard", false],
  rate_limit: ["rateLimit", true],
  overloaded: ["rateLimit", true],
  model_not_found: ["modelUnavailable", false],
  invalid_request: ["unknown", false],
  server_error: ["unknown", true],
  max_output_tokens: ["unknown", false],
};

/**
 * A failed Claude turn as an `AgentFailure`: the result's `api_error_status`, the error the SDK put
 * on its synthetic API-error message, and the result text, which holds the API's own message.
 */
export const claudeFailure = (
  httpStatus: number | undefined,
  error: string | undefined,
  text: string,
): AgentFailure => {
  if (httpStatus === undefined && /^Login expired\b/i.test(text.trim())) {
    return failure("auth", false, undefined, error);
  }
  const known = error === undefined ? undefined : CLAUDE_KINDS[error];
  return known === undefined || gatewayWords(text)
    ? httpFailure(httpStatus, text, error)
    : failure(known[0], known[1], httpStatus, error);
};
