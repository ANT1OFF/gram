import {
  gatewayEfforts,
  helperChoice,
  helperFallbackChoice,
  type GatewayProfile,
  type HelperKind,
  type ReasoningVariant,
} from "@gram/contracts";

/** One model a helper job may run on, and the effort to send it; an absent effort sends none. */
export interface HelperRoute {
  readonly model: string;
  readonly effort?: ReasoningVariant | undefined;
}

/**
 * The default model's effort per kind. A title gets `high`, as it always has, since it is two calls
 * a thread; the rest run often enough that `low` is the budget.
 */
const KIND_EFFORT: Readonly<Record<HelperKind, ReasoningVariant>> = {
  title: "high",
  plan: "low",
  recap: "low",
  suggest: "low",
  wait: "low",
  notice: "low",
  stuck: "low",
};

/**
 * Azure answers `none` on these with a 400, and on chat completions LiteLLM drops it instead, so
 * the model thinks at its default and bills for thinking that was turned off.
 */
const REJECTS_NONE = /^(gpt-6\.1-sol|gpt-6-astra|gpt-latest|gpt-chat-latest)/i;

/**
 * `effort` as the model will take it: `none` raised to `low` where it's rejected, and one the model
 * doesn't list over chat completions (`gatewayEfforts`, as Settings → AI helpers offers them) lowered
 * to `low`, or dropped for a model with no effort setting. A model nothing is said about takes any.
 */
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
 * own effort is sent as picked; the default model gets the kind's effort, or the job's `effort`.
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
    // Only the built-in default carries an effort without the user having picked one.
    const byDefault = profile.helperModel === undefined && primary.effort !== undefined;
    add(primary.model, byDefault ? (options.effort ?? KIND_EFFORT[options.kind]) : primary.effort);
  }
  if (fallback !== undefined) add(fallback.model, fallback.effort);
  return routes;
};

/** US dollars per million tokens. Reasoning is billed as output. */
interface Price {
  readonly input: number;
  readonly output: number;
}

const HAIKU_4_5: Price = { input: 1, output: 5 };
const BEDROCK_HAIKU_5_5: Price = { input: 0.11, output: 0.55 };

/** Historical token estimates, not the configured provider's prices or a billing guarantee. */
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
  typeof error === "object" && error !== null ? (error as Record<string, unknown>)[key] : undefined;

/**
 * Sorts a failed call from its status, body and headers. The body is read here and nowhere else:
 * it can quote the request, which is the user's conversation, so only the class leaves.
 */
export const classifyFailure = (error: unknown): ClassifiedFailure => {
  const status = field(error, "statusCode");
  const body = `${String(field(error, "responseBody") ?? "")} ${error instanceof Error ? error.message : ""}`;
  const headers = field(error, "responseHeaders");
  const retryAfter =
    typeof headers === "object" && headers !== null
      ? Number((headers as Record<string, unknown>)["retry-after"])
      : Number.NaN;
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
    // A real cooldown names the deployment that is cooling down; the router's filter names none.
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
