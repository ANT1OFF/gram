import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, CacheWriteSplit, TokenUsage } from "@gram/contracts";
import { learnedRate, listRate, weightedTokens } from "./cost-estimate.ts";

type UsageEvent = Extract<AgentEvent, { readonly type: "usage" }>;
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const int = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;

const tokenUsage = (usage: unknown): TokenUsage => {
  const u = asRecord(usage);
  const cacheRead = int(u["cache_read_input_tokens"]);
  const cacheWrite = int(u["cache_creation_input_tokens"]);
  const reasoning = int(asRecord(u["output_tokens_details"])["thinking_tokens"]);
  return {
    inputTokens: int(u["input_tokens"]) ?? 0,
    outputTokens: int(u["output_tokens"]) ?? 0,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
};

/**
 * A request's cache writes by TTL, from `usage.cache_creation`; `undefined` when the report has no
 * breakdown, which an older CLI or a gateway can omit.
 */
const cacheWriteSplit = (usage: unknown): CacheWriteSplit | undefined => {
  const split = asRecord(asRecord(usage)["cache_creation"]);
  const fiveMinute = int(split["ephemeral_5m_input_tokens"]);
  const oneHour = int(split["ephemeral_1h_input_tokens"]);
  return fiveMinute === undefined && oneHour === undefined
    ? undefined
    : { fiveMinute: fiveMinute ?? 0, oneHour: oneHour ?? 0 };
};

/**
 * A model id's trailing variant tag, `[1m]` of `claude-opus-5[1m]`, or `""`. Plain string work: the
 * id is the agent's to choose, and a regex over it was flagged as polynomial.
 */
const tagOf = (model: string): string => {
  const open = model.endsWith("]") ? model.lastIndexOf("[") : -1;
  return open < 0 ? "" : model.slice(open);
};

/** A model id without its trailing variant tag: `claude-opus-5[1m]` is `claude-opus-5`. */
const untagged = (model: string): string => model.slice(0, model.length - tagOf(model).length);

const totalOf = (u: TokenUsage): number =>
  u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

/**
 * The best of two reports of the SAME request. A request is reported up to three times — the
 * stream's `message_start` and `message_delta`, and the complete assistant message (once per
 * content block, all carrying `message_start`'s numbers) — and only `message_delta` has the final
 * output count, so each field's largest value is the one to keep.
 */
const maxTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => {
  const cacheRead = Math.max(a.cacheReadTokens ?? 0, b.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(a.cacheWriteTokens ?? 0, b.cacheWriteTokens ?? 0);
  const reasoning = Math.max(a.reasoningTokens ?? 0, b.reasoningTokens ?? 0);
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  };
};

/** Adds usage from distinct requests or SDK iterations, including optional token counts. */
export const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => {
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheRead === 0 ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === 0 ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  };
};

/** Owns the request ledger, context meter and session cost across Claude turns. */
export const makeUsageLedger = (
  options: {
    readonly rates?: Map<string, number>;
    readonly carriedCost?: number;
  } = {},
) => {
  /** The latest main-agent request's whole prompt; subagents have their own contexts. */
  let contextTokens: number | undefined;
  /** The main lane's wire model id. `modelUsage` keys its entry by it, and subagents' by theirs. */
  let mainModel: string | undefined;
  /**
   * The model the session currently runs as it was asked for, from `init` and then every switch. It
   * keeps the variant tag (`claude-opus-5[1m]`) that API messages drop and `modelUsage` keys by.
   */
  let sessionModel: string | undefined;
  /** Context windows by model id, kept across turns so a mid-turn report carries one too. */
  const contextWindows = new Map<string, number>();
  /** Largest window seen, the only guess left while the main model is still unknown. */
  let anyWindow: number | undefined;
  /** The running turn's main-loop requests, by API message id. */
  const requests = new Map<string, TokenUsage>();
  /** Those requests' cache writes by TTL, for the ones that reported a breakdown. */
  const splits = new Map<string, CacheWriteSplit>();
  /** Those requests summed, as last reported. */
  let turnTokens: TokenUsage | undefined;
  /** Everything this session has been charged up to the running turn, counted from zero. */
  let sessionCost = 0;
  /** The latest `total_cost_usd` as the CLI reported it, which may include a restored total. */
  let reportedCost = options.carriedCost ?? 0;
  /** What `total_cost_usd` is ahead of `sessionCost`. */
  let costOffset = reportedCost;
  const rates = options.rates ?? new Map<string, number>();
  let advertised: number | undefined;

  /**
   * The main model's entry in a map keyed like `modelUsage`. A message names the bare model while
   * `modelUsage` keeps the variant tag, so a 1M session's 1M window sits under `model[1m]`. Only the
   * session model's tag is used, since it may be an alias (`opus[1m]`). `modelUsage` is cumulative,
   * so after a switch between `model` and `model[1m]`, or with a subagent on the other one, both
   * entries are there and the tag is what tells them apart.
   */
  const ofMainModel = <T>(byModel: ReadonlyMap<string, T>): T | undefined => {
    if (mainModel === undefined) return undefined;
    const tag = sessionModel === undefined ? "" : tagOf(sessionModel);
    const asked = tag === "" ? undefined : byModel.get(mainModel + tag);
    if (asked !== undefined) return asked;
    const exact = byModel.get(mainModel);
    if (exact !== undefined) return exact;
    for (const [id, value] of byModel) if (untagged(id) === mainModel) return value;
    return undefined;
  };

  const startTurnUsage = (): void => {
    requests.clear();
    splits.clear();
    turnTokens = undefined;
  };

  /** The running turn's cache writes by TTL, summed; `undefined` when no request reported one. */
  const turnSplit = (): CacheWriteSplit | undefined =>
    splits.size === 0
      ? undefined
      : [...splits.values()].reduce((a, b) => ({
          fiveMinute: a.fiveMinute + b.fiveMinute,
          oneHour: a.oneHour + b.oneHour,
        }));

  /**
   * `costUsd` is the session's priced total. Without one the turn is still running, and the cost is
   * that total plus a guess at the turn: main-loop tokens only, so a turn that runs subagents
   * reads low until its `result`.
   */
  const usage = (
    tokens: TokenUsage,
    costUsd?: number,
    cacheWrites: CacheWriteSplit | undefined = turnSplit(),
  ): UsageEvent => {
    const contextWindow = mainModel === undefined ? anyWindow : ofMainModel(contextWindows);
    const rate =
      costUsd !== undefined || mainModel === undefined
        ? undefined
        : (ofMainModel(rates) ?? advertised ?? listRate(mainModel));
    const cost =
      costUsd !== undefined
        ? { costUsd }
        : rate !== undefined
          ? { costUsd: sessionCost + rate * weightedTokens(tokens), costEstimated: true }
          : {};
    return {
      type: "usage",
      tokens,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...cost,
      ...(cacheWrites === undefined ? {} : { cacheWrites }),
    };
  };

  /**
   * Books one report of a main-loop request and reports the turn so far. Merging per request and
   * summing the requests keeps the running total on the same ledger as the turn's `result`, so the
   * meter moves during the turn instead of jumping once at its end.
   */
  const record = (apiMessageId: string, raw: unknown): UsageEvent | undefined => {
    const reported = tokenUsage(raw);
    const prompt =
      reported.inputTokens + (reported.cacheReadTokens ?? 0) + (reported.cacheWriteTokens ?? 0);
    if (prompt > 0) contextTokens = prompt;
    const before = requests.get(apiMessageId);
    requests.set(apiMessageId, before === undefined ? reported : maxTokens(before, reported));
    // Like the tokens, each report of a request repeats its writes: keep the larger of each.
    const split = cacheWriteSplit(raw);
    if (split !== undefined) {
      const seen = splits.get(apiMessageId);
      splits.set(
        apiMessageId,
        seen === undefined
          ? split
          : {
              fiveMinute: Math.max(seen.fiveMinute, split.fiveMinute),
              oneHour: Math.max(seen.oneHour, split.oneHour),
            },
      );
    }
    const total = [...requests.values()].reduce(addTokens);
    if (totalOf(total) === 0 || (turnTokens !== undefined && totalOf(total) <= totalOf(turnTokens)))
      return;
    turnTokens = total;
    return usage(total);
  };

  return {
    startTurn: startTurnUsage,
    record,
    finish: (m: SDKResultMessage): UsageEvent => {
      // `modelUsage` covers subagents and compaction too, so the meter must read the main model's
      // entry: the largest window in there is whichever model ran the widest context, not this one.
      for (const [id, u] of Object.entries(m.modelUsage ?? {})) {
        const rate = learnedRate(u);
        if (rate !== undefined) rates.set(id, rate);
        const window = int(u.contextWindow);
        if (window === undefined || window <= 0) continue;
        contextWindows.set(id, window);
        if (u.canonicalModel !== undefined) contextWindows.set(u.canonicalModel, window);
        anyWindow = Math.max(anyWindow ?? 0, window);
      }
      const summed = turnTokens;
      const writes = turnSplit() ?? cacheWriteSplit(m.usage);
      startTurnUsage();
      // `m.usage` is the main loop's turn total and the summed requests are the same ledger, so take
      // whichever is further along rather than let the meter step backwards at the end of a turn.
      const reported = tokenUsage(m.usage);
      const tokens =
        summed !== undefined && totalOf(summed) > totalOf(reported) ? summed : reported;
      // `contextTokens`: occupancy is the last request's prompt, not the turn's summed tokens.
      // `costUsd`: cumulative for the agent session, not per turn. A counter that went backwards was
      // restarted under us (`/clear`, a crash's zeroes), so all it shows is new since.
      if (m.total_cost_usd < reportedCost) costOffset = -sessionCost;
      reportedCost = m.total_cost_usd;
      sessionCost = m.total_cost_usd - costOffset;
      return usage(tokens, sessionCost, writes);
    },
    get contextTokens() {
      return contextTokens;
    },
    get sessionModel() {
      return sessionModel;
    },
    setContextTokens: (tokens: number) => {
      contextTokens = tokens;
    },
    setWireModel: (model: string | undefined) => {
      mainModel = model ?? mainModel;
    },
    setSessionModel: (model: string) => {
      sessionModel = model;
    },
    setAdvertisedRate: (rate: number | undefined) => {
      advertised = rate;
    },
  };
};
