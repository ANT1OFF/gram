import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, CacheWriteSplit, TokenUsage } from "@gram/contracts";
import { learnedRate, listRate, weightedTokens } from "./cost-estimate.ts";
import * as Predicate from "effect/Predicate";

type UsageEvent = Extract<AgentEvent, { readonly type: "usage" }>;
const asRecord = (value: unknown): Record<string, unknown> =>
  Predicate.isObject(value) ? value : {};
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

const cacheWriteSplit = (usage: unknown): CacheWriteSplit | undefined => {
  const split = asRecord(asRecord(usage)["cache_creation"]);
  const fiveMinute = int(split["ephemeral_5m_input_tokens"]);
  const oneHour = int(split["ephemeral_1h_input_tokens"]);
  return fiveMinute === undefined && oneHour === undefined
    ? undefined
    : { fiveMinute: fiveMinute ?? 0, oneHour: oneHour ?? 0 };
};

const tagOf = (model: string): string => {
  const open = model.endsWith("]") ? model.lastIndexOf("[") : -1;
  return open < 0 ? "" : model.slice(open);
};

const untagged = (model: string): string => model.slice(0, model.length - tagOf(model).length);

const totalOf = (u: TokenUsage): number =>
  u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

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
  let contextTokens: number | undefined;
  let mainModel: string | undefined;
  let sessionModel: string | undefined;
  const contextWindows = new Map<string, number>();
  let anyWindow: number | undefined;
  const requests = new Map<string, TokenUsage>();
  const splits = new Map<string, CacheWriteSplit>();
  let turnTokens: TokenUsage | undefined;
  let sessionCost = 0;
  let reportedCost = options.carriedCost ?? 0;
  let costOffset = reportedCost;
  const rates = options.rates ?? new Map<string, number>();
  let advertised: number | undefined;

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

  const turnSplit = (): CacheWriteSplit | undefined =>
    splits.size === 0
      ? undefined
      : [...splits.values()].reduce((a, b) => ({
          fiveMinute: a.fiveMinute + b.fiveMinute,
          oneHour: a.oneHour + b.oneHour,
        }));

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

  const record = (apiMessageId: string, raw: unknown): UsageEvent | undefined => {
    const reported = tokenUsage(raw);
    const prompt =
      reported.inputTokens + (reported.cacheReadTokens ?? 0) + (reported.cacheWriteTokens ?? 0);
    if (prompt > 0) contextTokens = prompt;
    const before = requests.get(apiMessageId);
    requests.set(apiMessageId, before === undefined ? reported : maxTokens(before, reported));
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
      const reported = tokenUsage(m.usage);
      const tokens =
        summed !== undefined && totalOf(summed) > totalOf(reported) ? summed : reported;
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
