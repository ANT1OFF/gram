import {
  gatewayEfforts,
  helperChoice,
  helperFallbackChoice,
  helperKindEffort,
  type GatewayProfile,
  type HelperKind,
  type ReasoningVariant,
} from "@gram/contracts";
import * as Predicate from "effect/Predicate";

/** One model a helper job may run on, and the effort to send it; an absent effort sends none. */
export interface HelperRoute {
  readonly model: string;
  readonly effort?: ReasoningVariant | undefined;
}

const KIND_EFFORT = (kind: HelperKind): ReasoningVariant => helperKindEffort(kind);

const REJECTS_NONE = /^(gpt-6\.1-sol|gpt-6-astra|gpt-latest|gpt-chat-latest)/i;

const clampEffort = (
  profile: GatewayProfile,
  model: string,
  effort: ReasoningVariant | undefined,
): ReasoningVariant | undefined => {
  if (effort === undefined) return undefined;
  const clamped = effort === "none" && REJECTS_NONE.test(model) ? "low" : effort;
  const entry = profile.models.find((m) => m.id === model);
  const listed = entry === undefined ? undefined : gatewayEfforts(entry, "chat");
  if (listed === undefined || listed.includes(clamped)) return clamped;
  return listed.includes("low") ? "low" : undefined;
};

/**
 * The models a job tries, in order: the profile's helper model and its fallback. A thread on a
 * model id carries no implied data classification or region. The user's
 * own effort is sent as picked; a default model, primary or fallback, gets the kind's effort, or
 * the job's `effort`.
 */
export const helperRoutes = (
  profile: GatewayProfile,
  options: {
    readonly kind: HelperKind;
    readonly effort?: ReasoningVariant | undefined;
  },
): ReadonlyArray<HelperRoute> => {
  const primary = helperChoice(profile);
  const fallback = helperFallbackChoice(profile);
  const routes: Array<HelperRoute> = [];
  const add = (model: string, effort: ReasoningVariant | undefined) => {
    const id = model;
    if (routes.some((route) => route.model === id)) return;
    routes.push({ model: id, effort: clampEffort(profile, id, effort) });
  };
  if (primary !== undefined) {
    const byDefault = profile.helperModel === undefined && primary.effort !== undefined;
    add(primary.model, byDefault ? (options.effort ?? KIND_EFFORT(options.kind)) : primary.effort);
  }
  if (fallback !== undefined) {
    const automatic = profile.helperFallback === undefined && fallback.effort !== undefined;
    add(
      fallback.model,
      automatic ? (options.effort ?? KIND_EFFORT(options.kind)) : fallback.effort,
    );
  }
  return routes;
};

interface Price {
  readonly input: number;
  readonly output: number;
}

const HAIKU_4_5: Price = { input: 1, output: 5 };
const BEDROCK_HAIKU_5_5: Price = { input: 0.11, output: 0.55 };

const PRICES: Readonly<Record<string, Price>> = {
  "claude-haiku-5.5-eu": BEDROCK_HAIKU_5_5,
  "claude-haiku-5.5": BEDROCK_HAIKU_5_5,
  "a-claude-haiku-5.5": { input: 0.1, output: 0.5 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6-luna-eu": { input: 0.12, output: 0.6 },
  "a-claude-haiku-4.5": HAIKU_4_5,
  "claude-haiku-4.5": HAIKU_4_5,
  "claude-haiku-4.5-eu": HAIKU_4_5,
};

/** What a call cost; a model missing from the table is costed at Haiku's rate, the dear side. */
export const costUsd = (model: string, inputTokens: number, outputTokens: number): number => {
  const price = PRICES[model] ?? HAIKU_4_5;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};

/**
 * Why a call came back with nothing, as far as the next call is concerned:
 * - `timeout`, `rateLimited`, `server`, `network`: transient; the model backs off and the job goes
 *   to the fallback.
 * - `filtered` (a 429 "No deployments available" with nothing cooling down, which is the router
 *   refusing the request's shape) and `effortRejected` (a 400 on the effort): deterministic for
 *   that model and effort, so they aren't retried there this session.
 * - `keyDisabled`: the gateway's cost guard disabled the key; nothing goes out until the next UTC day.
 * - `restricted`: the key may not use the model; it is skipped for a day.
 * - `rejected`: any other 4xx, which would fail the same way anywhere.
 * - `malformed`: the answer wasn't the shape asked for; the fallback gets one try.
 */
export type HelperFailureClass =
  | "auth"
  | "restriction"
  | "unavailable"
  | "timeout"
  | "rateLimited"
  | "server"
  | "network"
  | "filtered"
  | "effortRejected"
  | "keyDisabled"
  | "restricted"
  | "rejected"
  | "malformed";

export interface ClassifiedFailure {
  readonly failure: HelperFailureClass;
  readonly status?: number | undefined;
  /** The gateway's `retry-after`, in ms. */
  readonly retryAfterMs?: number | undefined;
}

const field = (error: unknown, key: string): unknown =>
  Predicate.isObject(error) ? error[key] : undefined;

/**
 * Sorts a failed call from its status, body and headers. The body is read here and nowhere else:
 * it can quote the request, which is the user's conversation, so only the class leaves.
 */
export const classifyFailure = (error: unknown): ClassifiedFailure => {
  const status = field(error, "statusCode");
  const body = `${String(field(error, "responseBody") ?? "")} ${error instanceof Error ? error.message : ""}`;
  const headers = field(error, "responseHeaders");
  const retryAfter = Predicate.isObject(headers) ? Number(headers["retry-after"]) : Number.NaN;
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  if (typeof status !== "number") {
    const name = error instanceof Error ? error.name : "";
    return { failure: /abort|timeout/i.test(name) ? "timeout" : "network" };
  }
  const of = (failure: HelperFailureClass): ClassifiedFailure => ({
    failure,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  if (status === 429) {
    return /No deployments available/i.test(body) && /cooldown_list=\[\s*\]/.test(body)
      ? of("filtered")
      : of("rateLimited");
  }
  if (status === 403) {
    if (/API key is disabled/i.test(body)) return of("keyDisabled");
    if (/restricted for this API key/i.test(body)) return of("restricted");
    return of("rejected");
  }
  if (status === 404) return of("restricted");
  if (status === 400 && /reasoning[_ ]effort/i.test(body)) return of("effortRejected");
  if (status === 408) return of("timeout");
  if (status >= 500) return of("server");
  return of("rejected");
};

/** Back-off after the `n`th transient failure in a row: 20 s doubling to 15 min, or `retry-after`. */
export const backoffMs = (n: number, retryAfterMs?: number): number =>
  Math.max(retryAfterMs ?? 0, Math.min(20_000 * 2 ** Math.max(0, n - 1), 15 * 60_000));

/** Whether the job's other model may still help after this failure. */
export const triesFallback = (failure: HelperFailureClass): boolean =>
  failure !== "keyDisabled" &&
  failure !== "rejected" &&
  failure !== "auth" &&
  failure !== "restriction";

/** The UTC day of `ms`, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The next UTC midnight after `ms`. */
export const nextUtcMidnight = (ms: number): number => {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
};
