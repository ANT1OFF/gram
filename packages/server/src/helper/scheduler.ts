// The only door to helper-model calls. Titles, plans, recaps, suggestions and Waiting on you all
// come through `schedule`; isolated local adapters and the explicit gateway transport live behind it. That
// is what makes three promises checkable in one place:
//
// - A helper call can't act: local adapters verify no tools/MCP; gateway requests offer no tools.
// - Every call lands in the `helper_usage` ledger, which local call caps and the gateway estimate
//   budget reads, and an output whose basis hasn't changed is served from `helper_outputs` with no
//   call at all.
// - No transcript text reaches a log: a line here says kind, thread, model, lane, time, tokens,
//   cost and the failure's class and status, never a prompt, an output or an error's message or
//   body, which can quote the request. `helper-leaks.test.ts` holds this to it.

import { createHash } from "node:crypto";
import { HelperTransportError, type HelperCall } from "@gram/agents";

import {
  helperDailyBudgetUsd,
  helperHourlyCalls,
  helperOn,
  helperSource,
  helperLocalFallback,
  helperLocalContextAllowed,
  localHelperModel,
  localHelperEffort,
  localHelperEffortSupported,
  helperContextAllowed,
  SUGGEST_COUNTS_DAYS,
  type GatewayProfile,
  type HelperKind,
  type HelperStatus,
  type ReasoningVariant,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import type { LanguageModel } from "ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { AgentHosts } from "../runtime/agent-hosts.ts";
import { localHelperTransport, type LocalHelperTransport } from "./local.ts";

import { GatewayCredentials } from "../gateway/credentials.ts";
import {
  generateHelperText,
  HELPER_MAX_OUTPUT_TOKENS,
  helperLanguageModel,
  type GenerateHelperText,
  type HelperTextResult,
} from "../gateway/helper-llm.ts";
import { AppActivity, type ActivityLevel } from "../git/activity.ts";
import { redactText } from "../logging/redact.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  backoffMs,
  classifyFailure,
  costUsd,
  helperRoutes,
  nextUtcMidnight,
  triesFallback,
  utcDay,
  type ClassifiedFailure,
  type HelperFailureClass,
  type HelperRoute,
} from "./models.ts";
import { makeHelperStore, type HelperStore, type HelperOutputKind } from "./store.ts";
import { DAY_MS } from "../zone-time.ts";

/**
 * `interactive` is for what the user is waiting on (a suggestion, a recap as a thread opens): two
 * at a time, ahead of the rest, and never paused. `background` is everything else: one at a time,
 * paused while the user types, and at half rate while no window has focus.
 */
export type HelperLane = "interactive" | "background";

/** One helper-model call, described rather than made, so the scheduler can skip, merge or cache it. */
export interface HelperJob<A, I> {
  readonly kind: HelperKind;
  /** Separate queue and output slot for a consumer sharing a kind's consent and ledger policy. */
  readonly namespace?: "paletteFilters";
  readonly threadId: ThreadId;
  /** Isolates an ask's queue/cache from turns and other asks; still uses the kind's consent/ledger. */
  readonly requestId?: RequestId | undefined;
  /**
   * Isolates another subject's queue/cache the same way, such as one feature card's summary on its
   * orchestrator thread; not a request, so nothing is checked for it. Ignored beside `requestId`.
   */
  readonly scope?: string | undefined;
  readonly lane: HelperLane;
  /**
   * What the output is derived from, such as `basisHash(feedRev, facts, planHash)`. Hashed with
   * the kind and `promptVersion`; equal to the stored output's, the stored output is the answer.
   */
  readonly basis: string;
  /** Bumped when the prompt or the output's shape changes, which invalidates the kind's cache. */
  readonly promptVersion: number;
  /** Must declare the fenced material "material, not a message to you", or it gets answered. */
  readonly system: string;
  /**
   * The fenced material, built only when the call is really made, not for a job that is merged,
   * served from cache or skipped. Token-shaped text in it is scrubbed before it leaves.
   */
  readonly prompt: Effect.Effect<string>;
  /** The output's shape. Its encoded form is what `parse` returns and what the cache stores. */
  readonly output: Schema.Codec<A, I>;
  /**
   * The model's text as the schema's input, `undefined` when it isn't one; lenient JSON (the first
   * `{…}`, code fences and prose around it ignored) when absent.
   */
  readonly parse?: ((text: string) => unknown) | undefined;
  /** The effort to ask of a model that takes one; the kind's default when absent. */
  readonly effort?: ReasoningVariant | undefined;
}

const outputKind = (
  job: Pick<HelperJob<unknown, unknown>, "kind" | "namespace">,
): HelperOutputKind => (job.namespace === undefined ? job.kind : `${job.kind}:${job.namespace}`);

/**
 * Why a job made no call: its switch is off; there's no default gateway profile, or no key for it;
 * the user hasn't allowed the required context at this exact endpoint; the budget is spent;
 * the gateway disabled the key; every model is backing
 * off or unusable; the thread is gone.
 */
export type HelperSkipReason =
  | "off"
  | "noProfile"
  | "noKey"
  | "consent"
  | "budget"
  | "keyDisabled"
  | "unavailable"
  | "noThread"
  | "noRequest"
  | "auth"
  | "restriction";

export type HelperResult<A> =
  | {
      readonly _tag: "Done";
      readonly value: A;
      /** Served from `helper_outputs` without a call. */
      readonly cached: boolean;
      readonly model?: string | undefined;
    }
  | { readonly _tag: "Skipped"; readonly reason: HelperSkipReason }
  /** A newer basis for the same kind, thread and request scope replaced the job before it ran. */
  | { readonly _tag: "Superseded" }
  | { readonly _tag: "Failed"; readonly failure: HelperFailureClass | "defect" };

/** A thread's stored output of a kind, whatever basis it came from. */
interface HelperLatest<A> {
  readonly value: A;
  readonly basis: string;
  readonly createdAt: number;
  readonly model: string;
}

export interface HelperSchedulerShape {
  /** Runs `job`, or explains why not. Never fails. */
  readonly schedule: <A, I>(job: HelperJob<A, I>) => Effect.Effect<HelperResult<A>>;
  readonly latest: <A, I>(
    threadId: ThreadId,
    kind: HelperKind,
    output: Schema.Codec<A, I>,
  ) => Effect.Effect<Option.Option<HelperLatest<A>>>;
  /** Adds `n` to today's `helper_events` counter for `kind` and `event`. */
  readonly recordEvent: (kind: HelperKind, event: string, n?: number) => Effect.Effect<void>;
  readonly presence: (presence: { readonly typing: boolean }) => Effect.Effect<void>;
  readonly status: Effect.Effect<HelperStatus>;
}

/** A stable hash of `parts`, whatever order their objects' keys were written in. */
export const basisHash = (...parts: ReadonlyArray<unknown>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(parts, (_key, value: unknown) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          : value,
      ),
    )
    .digest("hex")
    .slice(0, 32);

/**
 * The first balanced `{…}` in `text`, parsed: models wrap JSON in code fences and a sentence
 * often enough, even when told not to. `undefined` when there is none.
 */
export const parseJsonOutput = (text: string): unknown => {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as unknown;
      } catch {
        // Balanced but not JSON (a brace in prose): there is no second chance in the same text.
        return undefined;
      }
    }
  }
  return undefined;
};

const CONCURRENCY: Readonly<Record<HelperLane, number>> = { interactive: 2, background: 1 };

/** A kind's calls a UTC day. Titles have none: the watcher asks at most twice a thread. */
const KIND_DAILY_CALLS: Readonly<Partial<Record<HelperKind, number>>> = {
  plan: 400,
  suggest: 600,
  recap: 100,
  wait: 300,
  notice: 200,
  stuck: 100,
};

/** The share of the daily budget past which the background lane stops, titles excepted. */
const BACKGROUND_SHARE = 0.8;

/** How long after a `typing: true` the pause lasts without another: the client's 2 s throttle. */
const TYPING_THROTTLE_MS = 2_000;

const RESTRICTED_MS = DAY_MS;

export interface HelperSchedulerDeps {
  readonly store: ThreadStore["Service"];
  readonly helperStore: HelperStore;
  /** The profile's key, if one is stored. */
  readonly key: (
    profile: GatewayProfile,
  ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  readonly local?: LocalHelperTransport | undefined;
  readonly generate?: GenerateHelperText | undefined;
  readonly languageModel?:
    | ((
        profile: GatewayProfile,
        key: Redacted.Redacted<string>,
        model: string,
        kind: HelperKind,
      ) => LanguageModel)
    | undefined;
  readonly activity?: { readonly level: Effect.Effect<ActivityLevel> } | undefined;
  readonly timeoutMs?: number | undefined;
  /** How long background jobs wait after the user stops typing. */
  readonly typingGraceMs?: number | undefined;
  /** Per-kind daily call caps, `KIND_DAILY_CALLS` when absent. */
  readonly kindDailyCalls?: Readonly<Partial<Record<HelperKind, number>>> | undefined;
}

interface Entry {
  readonly job: HelperJob<unknown, unknown>;
  readonly key: string;
  readonly basis: string;
  lane: HelperLane;
  readonly done: Deferred.Deferred<HelperResult<unknown>>;
  waiters: number;
  canceled: boolean;
  execution?: Fiber.Fiber<HelperResult<unknown>>;
}

/** Per model: transient failures in a row and when it may be asked again. */
interface Health {
  failures: number;
  until: number;
}

type Attempt =
  | { readonly ok: true; readonly result: HelperTextResult }
  | { readonly ok: false; readonly error: ClassifiedFailure };

const skipped = (reason: HelperSkipReason): HelperResult<never> => ({ _tag: "Skipped", reason });

const decode = <A, I>(output: Schema.Codec<A, I>, data: unknown) =>
  Schema.decodeUnknownOption(output as Schema.Codec<A, unknown>)(data);

/** The job's reading of `text`; a parser that throws has read an answer that isn't one. */
const parseOutput = (job: HelperJob<unknown, unknown>, text: string): unknown => {
  try {
    return (job.parse ?? parseJsonOutput)(text);
  } catch {
    // The throw's message may quote the answer, so it goes no further than this.
    return undefined;
  }
};

const logSkip = (job: HelperJob<unknown, unknown>, reason: HelperSkipReason) =>
  Effect.logDebug(`helper ${job.kind} skipped: thread ${job.threadId}, ${reason}`).pipe(
    Effect.as(skipped(reason)),
  );

/** The scheduler, with its lane workers forked into the surrounding scope. */
export const makeHelperScheduler = (deps: HelperSchedulerDeps) =>
  Effect.gen(function* () {
    const generate = deps.generate ?? generateHelperText;
    const languageModel = deps.languageModel ?? helperLanguageModel;
    const timeoutMs = deps.timeoutMs ?? 20_000;
    const typingGraceMs = deps.typingGraceMs ?? 3_000;

    const pending = new Map<string, Entry>();
    const running = new Map<string, Entry>();
    const queues: Record<HelperLane, Array<string>> = { interactive: [], background: [] };
    const signals: Record<HelperLane, Queue.Queue<void>> = {
      interactive: yield* Queue.unbounded<void>(),
      background: yield* Queue.unbounded<void>(),
    };
    let lastOutcome: string | undefined;
    let typingUntil = 0;
    let keyDisabledUntil = 0;
    const health = new Map<string, Health>();
    const restrictedUntil = new Map<string, number>();
    /** `model|effort` pairs the gateway refused deterministically this session. */
    const incompatible = new Set<string>();
    /** Epoch ms of the last hour's calls, for the hourly cap. */
    let callTimes: Array<number> = [];
    /** Calls admitted and not yet in the ledger, per kind, so concurrent workers count each other. */
    const inFlight = new Map<HelperKind, number>();
    /** Admission is a read of the ledger and a reservation, which two workers mustn't interleave. */
    const admission = yield* Semaphore.make(1);

    const enqueue = (key: string, lane: HelperLane) =>
      Effect.gen(function* () {
        queues[lane].push(key);
        yield* Queue.offer(signals[lane], undefined);
      });

    const requestPending = (job: HelperJob<unknown, unknown>) =>
      job.requestId === undefined
        ? Effect.succeed(true)
        : deps.store
            .listRequests(job.threadId)
            .pipe(
              Effect.map((requests) => requests.some((request) => request.id === job.requestId)),
            );

    const cachedValue = <A, I>(job: HelperJob<A, I>, basis: string) =>
      deps.helperStore
        .getOutput(job.threadId, outputKind(job), job.requestId ?? job.scope)
        .pipe(
          Effect.map((row) =>
            row === undefined || row.basis !== basis
              ? Option.none<A>()
              : decode(job.output, row.data),
          ),
        );

    /** The route as it may be tried now, or nothing while its model is out of bounds. */
    const usable = (route: HelperRoute, now: number): HelperRoute | undefined => {
      if ((health.get(route.model)?.until ?? 0) > now) return undefined;
      if ((restrictedUntil.get(route.model) ?? 0) > now) return undefined;
      if (!incompatible.has(`${route.model}|${route.effort ?? ""}`)) return route;
      // The model refused the effort, not necessarily the model: try it with none.
      return route.effort !== undefined && !incompatible.has(`${route.model}|`)
        ? { model: route.model }
        : undefined;
    };

    const budgetReason = (entry: Entry, now: number) =>
      Effect.gen(function* () {
        const settings = yield* deps.store.getSettings;
        const lines = yield* deps.helperStore.usageOn(utcDay(now));
        const spent = lines.reduce((sum, line) => sum + line.costUsd, 0);
        const cap = helperDailyBudgetUsd(settings);
        const gateway = helperSource(settings) === "gateway";
        if (gateway && spent >= cap) return true;
        if (gateway && entry.lane === "background" && entry.job.kind !== "title") {
          if (spent >= cap * BACKGROUND_SHARE) return true;
        }
        callTimes = callTimes.filter((at) => at > now - 3_600_000);
        if (callTimes.length >= helperHourlyCalls(settings)) return true;
        const kindCap = (deps.kindDailyCalls ?? KIND_DAILY_CALLS)[entry.job.kind];
        const kindCalls = lines
          .filter((line) => line.kind === entry.job.kind)
          .reduce((sum, line) => sum + line.calls, inFlight.get(entry.job.kind) ?? 0);
        return kindCap !== undefined && kindCalls >= kindCap;
      });

    /**
     * Reserves one call against the caps, or says why not: the switch is off, the key is disabled
     * or the budget is spent. Every transport call goes through here, the fallback's too, so a
     * failed primary can't carry the job past a cap, a switch turned off or a key another job found
     * disabled meanwhile.
     */
    const admit = (
      entry: Entry,
      provider?: "claude" | "codex",
      profile?: GatewayProfile,
    ): Effect.Effect<HelperSkipReason | undefined> =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          // The switches too: one turned off while the primary was out stops the fallback.
          const settings = yield* deps.store.getSettings;
          if (!helperOn(settings, entry.job.kind)) return "off";
          const source = helperSource(settings);
          if (provider !== undefined) {
            if (
              source === "gateway" ||
              (source !== "automatic" &&
                source !== provider &&
                helperLocalFallback(settings) !== "automatic")
            )
              return "off";
            if (!helperLocalContextAllowed(settings, provider, entry.job.kind)) return "consent";
          } else {
            if (source !== "gateway") return "off";
            const current = (yield* deps.store.listProfiles).find((p) => p.default === true);
            if (
              current?.id !== profile?.id ||
              current?.baseURL !== profile?.baseURL ||
              current?.keyRef !== profile?.keyRef ||
              current === undefined ||
              !helperContextAllowed(current, entry.job.kind)
            )
              return "consent";
          }
          const now = yield* Clock.currentTimeMillis;
          if (source === "gateway" && keyDisabledUntil > now) return "keyDisabled";
          if (yield* budgetReason(entry, now)) return "budget";
          callTimes.push(now);
          inFlight.set(entry.job.kind, (inFlight.get(entry.job.kind) ?? 0) + 1);
          return undefined;
        }),
      );

    const settleCall = (kind: HelperKind) =>
      Effect.sync(() => {
        inFlight.set(kind, Math.max(0, (inFlight.get(kind) ?? 1) - 1));
      });

    const attempt = (
      job: HelperJob<unknown, unknown>,
      profile: GatewayProfile | undefined,
      key: Redacted.Redacted<string> | undefined,
      route: HelperRoute & { readonly provider?: "claude" | "codex" },
      prompt: string,
      authorize: HelperCall["authorize"],
    ): Effect.Effect<Attempt> =>
      (route.provider === undefined
        ? Effect.tryPromise({
            try: (signal) =>
              generate({
                model: languageModel(profile!, key!, route.model, job.kind),
                system: redactText(job.system),
                prompt,
                maxOutputTokens: HELPER_MAX_OUTPUT_TOKENS,
                abortSignal: signal,
                ...(route.effort === undefined ? {} : { reasoningEffort: route.effort }),
              }),
            catch: (error) => classifyFailure(error),
          })
        : deps.local === undefined
          ? Effect.fail<ClassifiedFailure>({ failure: "restriction" })
          : deps.local
              .generate(route.provider, {
                model: route.model,
                speed: "standard",
                system: redactText(job.system),
                prompt,
                maxOutputTokens: HELPER_MAX_OUTPUT_TOKENS,
                effort: route.effort,
                authorize,
              })
              .pipe(Effect.mapError((error): ClassifiedFailure => ({ failure: error.failure })))
      ).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map((result): Attempt =>
          Option.isSome(result)
            ? { ok: true, result: result.value }
            : { ok: false, error: { failure: "timeout" } },
        ),
        Effect.catch((error) => Effect.succeed<Attempt>({ ok: false, error })),
      );

    /** What the model's failure means for the next call to it. */
    const noteFailure = (route: HelperRoute, error: ClassifiedFailure, now: number) =>
      Effect.sync(() => {
        switch (error.failure) {
          case "timeout":
          case "rateLimited":
          case "server":
          case "network": {
            const previous = health.get(route.model)?.failures ?? 0;
            health.set(route.model, {
              failures: previous + 1,
              until: now + backoffMs(previous + 1, error.retryAfterMs),
            });
            return;
          }
          case "filtered":
          case "effortRejected":
            incompatible.add(`${route.model}|${route.effort ?? ""}`);
            return;
          case "restricted":
            restrictedUntil.set(route.model, now + RESTRICTED_MS);
            return;
          case "keyDisabled":
            keyDisabledUntil = nextUtcMidnight(now);
            return;
          case "auth":
          case "unavailable":
          case "restriction":
          case "rejected":
          case "malformed":
            return;
        }
      });

    const execute = (entry: Entry): Effect.Effect<HelperResult<unknown>> =>
      Effect.gen(function* () {
        const { job } = entry;
        const now = yield* Clock.currentTimeMillis;
        const settings = yield* deps.store.getSettings;
        if (!helperOn(settings, job.kind)) return yield* logSkip(job, "off");
        if (!(yield* requestPending(job))) return yield* logSkip(job, "noRequest");
        const cached = yield* cachedValue(job, entry.basis);
        if (Option.isSome(cached)) return { _tag: "Done", value: cached.value, cached: true };
        const source = helperSource(settings);
        if (source === "gateway" && keyDisabledUntil > now)
          return yield* logSkip(job, "keyDisabled");
        if (yield* budgetReason(entry, now)) return yield* logSkip(job, "budget");
        const thread = yield* deps.store.getThread(job.threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return yield* logSkip(job, "noThread");
        let profile: GatewayProfile | undefined;
        let key: Redacted.Redacted<string> | undefined;
        let planned: ReadonlyArray<HelperRoute & { readonly provider?: "claude" | "codex" }>;
        if (source === "gateway") {
          profile = (yield* deps.store.listProfiles).find((p) => p.default === true);
          if (profile === undefined) return yield* logSkip(job, "noProfile");
          if (!helperContextAllowed(profile, job.kind)) return yield* logSkip(job, "consent");
          const found = yield* deps.key(profile);
          if (Option.isNone(found)) return yield* logSkip(job, "noKey");
          key = found.value;
          planned = helperRoutes(profile, { kind: job.kind, effort: job.effort });
        } else {
          const order: ReadonlyArray<"claude" | "codex"> =
            source === "automatic"
              ? helperLocalFallback(settings) === "automatic"
                ? ["claude", "codex"]
                : ["claude"]
              : helperLocalFallback(settings) === "automatic"
                ? [source, source === "claude" ? "codex" : "claude"]
                : [source];
          const allowed = order.filter((provider) =>
            helperLocalContextAllowed(settings, provider, job.kind),
          );
          if (allowed.length === 0) return yield* logSkip(job, "consent");
          if (deps.local === undefined) return yield* logSkip(job, "unavailable");
          const providers = yield* deps.local.inspect;
          const primary = providers.find((p) => p.provider === allowed[0]);
          if (primary?.state === "auth" || primary?.state === "restriction") {
            lastOutcome = `${primary.provider}: ${primary.state}`;
            return yield* logSkip(job, primary.state);
          }
          planned = allowed.flatMap((provider) => {
            const status = providers.find((p) => p.provider === provider);
            const saved = settings.helpers?.[provider === "claude" ? "claudeModel" : "codexModel"];
            const model =
              status?.state === "ready"
                ? localHelperModel(provider, status.models, saved)
                : undefined;
            if (model === undefined) {
              lastOutcome = `${provider}: ${status?.state === "ready" ? "no eligible helper model" : (status?.state ?? "unavailable")}${saved === undefined ? "" : " (saved model unavailable)"}`;
              return [];
            }
            const effort = localHelperEffort(
              model,
              settings.helpers?.[provider === "claude" ? "claudeEffort" : "codexEffort"],
            );
            if (!localHelperEffortSupported(model, effort)) {
              lastOutcome = `${provider}: saved effort unavailable`;
              return [];
            }
            return [{ provider, model: saved ?? model.id, effort }];
          });
          // An explicit saved primary is deliberate: it is never replaced implicitly.
          const primarySaved =
            settings.helpers?.[order[0] === "claude" ? "claudeModel" : "codexModel"];
          const primaryEffort =
            settings.helpers?.[order[0] === "claude" ? "claudeEffort" : "codexEffort"];
          if (
            (primarySaved !== undefined || primaryEffort !== undefined) &&
            !planned.some((p) => p.provider === order[0])
          )
            return yield* logSkip(job, "unavailable");
        }
        if (source !== "gateway" && helperLocalFallback(settings) === "none")
          planned = planned.slice(0, 1);
        const routes = planned.flatMap((route) => {
          const available = usable(route, now);
          return available === undefined
            ? []
            : [
                {
                  ...available,
                  ...(route.provider === undefined ? {} : { provider: route.provider }),
                },
              ];
        });
        if (routes.length === 0) return yield* logSkip(job, "unavailable");

        const prompt = redactText(yield* job.prompt);
        for (const [index, route] of routes.entries()) {
          const currentSettings = yield* deps.store.getSettings;
          if (helperSource(currentSettings) !== source) return yield* logSkip(job, "off");
          if (route.provider !== undefined) {
            const modelKey = route.provider === "claude" ? "claudeModel" : "codexModel";
            const effortKey = route.provider === "claude" ? "claudeEffort" : "codexEffort";
            if (
              currentSettings.helpers?.[effortKey] !== settings.helpers?.[effortKey] ||
              currentSettings.helpers?.[modelKey] !== settings.helpers?.[modelKey] ||
              helperLocalFallback(currentSettings) !== helperLocalFallback(settings)
            )
              return yield* logSkip(job, "off");
          }
          const refused = yield* admit(entry, route.provider, profile);
          if (refused !== undefined) return yield* logSkip(job, refused);
          // The reservation is released however this ends, a defect or an interruption included,
          // or a lost slot would count against the caps for the rest of the session.
          const { started, ended, inputTokens, outputTokens, cost, value, error } =
            yield* Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;
              const sent = yield* attempt(job, profile, key, route, prompt, (sendPrompt) =>
                deps.store.getSettings.pipe(
                  Effect.flatMap((current) =>
                    Effect.try({
                      try: () => {
                        const provider = route.provider;
                        const modelKey = provider === "claude" ? "claudeModel" : "codexModel";
                        const effortKey = provider === "claude" ? "claudeEffort" : "codexEffort";
                        if (
                          provider === undefined ||
                          !helperOn(current, job.kind) ||
                          helperSource(current) !== source ||
                          !helperLocalContextAllowed(current, provider, job.kind) ||
                          current.helpers?.[modelKey] !== settings.helpers?.[modelKey] ||
                          current.helpers?.[effortKey] !== settings.helpers?.[effortKey] ||
                          helperLocalFallback(current) !== helperLocalFallback(settings)
                        )
                          throw new HelperTransportError({ failure: "restriction" });
                        // This check and the adapter's enqueue share one synchronous boundary.
                        sendPrompt();
                      },
                      catch: () => new HelperTransportError({ failure: "restriction" }),
                    }),
                  ),
                ),
              );
              const until = yield* Clock.currentTimeMillis;
              const reported = sent.ok ? sent.result.usage : undefined;
              const tokensIn = reported?.inputTokens ?? 0;
              const tokensOut = reported?.outputTokens ?? 0;
              const spent =
                route.provider === undefined ? costUsd(route.model, tokensIn, tokensOut) : 0;
              const decoded = sent.ok
                ? decode(job.output, parseOutput(job, sent.result.text))
                : Option.none<unknown>();
              const failure: ClassifiedFailure | undefined = sent.ok
                ? Option.isNone(decoded)
                  ? { failure: "malformed" }
                  : undefined
                : sent.error;
              yield* deps.helperStore.addUsage({
                day: utcDay(at),
                kind: job.kind,
                model:
                  route.provider === undefined
                    ? route.model
                    : `local:${route.provider}:${route.model}`,
                calls: 1,
                inputTokens: tokensIn,
                outputTokens: tokensOut,
                costUsd: spent,
                failures: failure === undefined ? 0 : 1,
              });
              return {
                started: at,
                ended: until,
                inputTokens: tokensIn,
                outputTokens: tokensOut,
                cost: spent,
                value: decoded,
                error: failure,
              };
            }).pipe(Effect.ensuring(settleCall(job.kind)));
          const facts =
            `thread ${job.threadId}, ${route.model}${route.effort === undefined ? "" : ` at ${route.effort}`}, ` +
            `${entry.lane} lane, ${ended - started} ms, ${inputTokens}+${outputTokens} tokens, $${cost.toFixed(5)}`;
          if (error === undefined && Option.isSome(value)) {
            lastOutcome = `${route.provider ?? "gateway"}: completed`;
            health.delete(route.model);
            yield* Effect.logDebug(`helper ${job.kind} done: ${facts}`);
            if (!(yield* requestPending(job))) return yield* logSkip(job, "noRequest");
            const encoded = Schema.encodeUnknownOption(
              job.output as Schema.Codec<unknown, unknown>,
            )(value.value);
            if (Option.isSome(encoded)) {
              yield* deps.helperStore.putOutput({
                threadId: job.threadId,
                kind: outputKind(job),
                requestId: job.requestId,
                scope: job.scope,
                basis: entry.basis,
                promptVersion: job.promptVersion,
                model: route.model,
                data: encoded.value,
                createdAt: ended,
              });
            }
            return { _tag: "Done", value: value.value, cached: false, model: route.model };
          }
          if (error === undefined) continue;
          yield* Effect.logWarning(
            `helper ${job.kind} failed: ${facts}, ${error.failure}` +
              (error.status === undefined ? "" : `, status ${error.status}`),
          );
          lastOutcome = `${route.provider ?? "gateway"}: ${error.failure}`;
          yield* noteFailure(route, error, ended);
          if (error.failure === "keyDisabled") return skipped("keyDisabled");
          if (index === routes.length - 1 || !triesFallback(error.failure)) {
            return { _tag: "Failed", failure: error.failure };
          }
        }
        return skipped("unavailable");
      });

    const nextEntry = (lane: HelperLane): Effect.Effect<Entry> =>
      Effect.gen(function* () {
        while (true) {
          if (lane === "background") {
            const wait = typingUntil - (yield* Clock.currentTimeMillis);
            if (wait > 0) {
              yield* Effect.sleep(wait);
              continue;
            }
          }
          const key = queues[lane].shift();
          if (key === undefined) {
            yield* Queue.take(signals[lane]);
            continue;
          }
          const entry = pending.get(key);
          // A key moved to the other lane, or already taken, stays behind in this queue.
          if (entry === undefined || entry.lane !== lane) continue;
          // One execution per key at a time, so an older basis can't land after a newer one: this
          // one waits in `pending` and is queued again when the running one ends.
          if (running.has(key)) continue;
          pending.delete(key);
          running.set(key, entry);
          return entry;
        }
      });

    const worker = (lane: HelperLane) =>
      Effect.gen(function* () {
        const entry = yield* nextEntry(lane);
        const started = yield* Clock.currentTimeMillis;
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const execution = yield* Effect.forkScoped(
              entry.canceled
                ? Effect.succeed<HelperResult<unknown>>({ _tag: "Superseded" })
                : execute(entry),
            );
            entry.execution = execution;
            if (entry.canceled) yield* Fiber.interrupt(execution);
            return yield* Fiber.await(execution);
          }),
        );
        const result: HelperResult<unknown> = Exit.isSuccess(outcome)
          ? outcome.value
          : entry.waiters === 0
            ? { _tag: "Superseded" }
            : yield* Effect.logWarning(
                `helper ${entry.job.kind} failed: thread ${entry.job.threadId}, defect`,
              ).pipe(Effect.as<HelperResult<unknown>>({ _tag: "Failed", failure: "defect" }));
        running.delete(entry.key);
        yield* Deferred.succeed(entry.done, result);
        const next = pending.get(entry.key);
        if (next !== undefined) yield* enqueue(entry.key, next.lane);
        const level = deps.activity === undefined ? "active" : yield* deps.activity.level;
        if (lane === "background" && level !== "active") {
          // Half rate: as long a rest as the job took.
          yield* Effect.sleep((yield* Clock.currentTimeMillis) - started);
        }
      }).pipe(Effect.forever);

    for (const lane of ["interactive", "background"] as const) {
      for (let i = 0; i < CONCURRENCY[lane]; i++) yield* Effect.forkScoped(worker(lane));
    }

    const awaitEntry = (entry: Entry) =>
      Effect.gen(function* () {
        entry.waiters++;
        return yield* Deferred.await(entry.done).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              entry.waiters--;
              if (entry.waiters > 0) return;
              entry.canceled = true;
              if (pending.get(entry.key) === entry) pending.delete(entry.key);
              if (entry.execution !== undefined) yield* Fiber.interrupt(entry.execution);
            }),
          ),
        );
      });

    const schedule = <A, I>(job: HelperJob<A, I>): Effect.Effect<HelperResult<A>> =>
      Effect.gen(function* () {
        if (!helperOn(yield* deps.store.getSettings, job.kind)) {
          return yield* logSkip(job as HelperJob<unknown, unknown>, "off");
        }
        const settings = yield* deps.store.getSettings;
        const profiles = helperSource(settings) === "gateway" ? yield* deps.store.listProfiles : [];
        const basis = basisHash(
          job.kind,
          job.promptVersion,
          job.basis,
          settings.helpers,
          profiles.find((p) => p.default === true),
        );
        if (!(yield* requestPending(job))) return yield* logSkip(job, "noRequest");
        const cached = yield* cachedValue(job, basis);
        if (Option.isSome(cached)) {
          return { _tag: "Done", value: cached.value, cached: true } satisfies HelperResult<A>;
        }
        const key = JSON.stringify([
          outputKind(job),
          job.threadId,
          job.requestId ?? job.scope ?? "",
        ]);
        const current = running.get(key);
        if (current?.basis === basis && !current.canceled) return yield* awaitEntry(current);
        const waiting = pending.get(key);
        if (waiting?.basis === basis) {
          if (job.lane === "interactive" && waiting.lane === "background") {
            waiting.lane = "interactive";
            yield* enqueue(key, "interactive");
          }
          return yield* awaitEntry(waiting);
        }
        // Someone waits on the key interactively, so it stays in that lane under a newer basis.
        const lane: HelperLane = waiting?.lane === "interactive" ? "interactive" : job.lane;
        const entry: Entry = {
          job: job as HelperJob<unknown, unknown>,
          key,
          basis,
          lane,
          done: yield* Deferred.make<HelperResult<unknown>>(),
          waiters: 0,
          canceled: false,
        };
        pending.set(key, entry);
        if (waiting === undefined || waiting.lane !== lane) yield* enqueue(key, lane);
        if (waiting !== undefined) yield* Deferred.succeed(waiting.done, { _tag: "Superseded" });
        return yield* awaitEntry(entry);
      }) as Effect.Effect<HelperResult<A>>;

    const status = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const settings = yield* deps.store.getSettings;
      const lines = yield* deps.helperStore.usageOn(utcDay(now));
      const sum = (pick: (line: (typeof lines)[number]) => number) =>
        lines.reduce((total, line) => total + pick(line), 0);
      const costUsdToday = sum((line) => line.costUsd);
      const dailyBudgetUsd = helperDailyBudgetUsd(settings);
      const paused: HelperStatus["paused"] =
        helperSource(settings) === "gateway" && keyDisabledUntil > now
          ? { reason: "keyDisabled", until: keyDisabledUntil }
          : helperSource(settings) === "gateway" && costUsdToday >= dailyBudgetUsd
            ? { reason: "budget", until: nextUtcMidnight(now) }
            : undefined;
      const since = utcDay(now - (SUGGEST_COUNTS_DAYS - 1) * DAY_MS);
      const counts = yield* deps.helperStore.eventsSince(since, "suggest");
      const count = (event: string) => counts[event] ?? 0;
      return {
        source: helperSource(settings),
        ...(deps.local === undefined || helperSource(settings) === "gateway"
          ? {}
          : { providers: yield* deps.local.inspect }),
        ...(lastOutcome === undefined ? {} : { lastOutcome }),
        suggestions: {
          since,
          shown: count("shown"),
          taken: count("taken"),
          accepted: count("accepted"),
          wordAccepted: count("wordAccepted"),
          editedAfter: count("editedAfter"),
          dismissed: count("dismissed"),
        },
        day: utcDay(now),
        calls: sum((line) => line.calls),
        inputTokens: sum((line) => line.inputTokens),
        outputTokens: sum((line) => line.outputTokens),
        costUsd: costUsdToday,
        failures: sum((line) => line.failures),
        lines,
        dailyBudgetUsd,
        ...(paused === undefined ? {} : { paused }),
      } satisfies HelperStatus;
    });

    const shape: HelperSchedulerShape = {
      schedule,
      latest: (threadId, kind, output) =>
        deps.helperStore.getOutput(threadId, kind).pipe(
          Effect.map((row) =>
            row === undefined
              ? Option.none()
              : decode(output, row.data).pipe(
                  Option.map((value) => ({
                    value,
                    basis: row.basis,
                    createdAt: row.createdAt,
                    model: row.model,
                  })),
                ),
          ),
        ),
      recordEvent: (kind, event, n = 1) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => deps.helperStore.addEvent(utcDay(now), kind, event, n)),
        ),
      presence: ({ typing }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          typingUntil = now + typingGraceMs + (typing ? TYPING_THROTTLE_MS : 0);
        }),
      status,
    };
    return shape;
  });

export class HelperScheduler extends Context.Service<HelperScheduler, HelperSchedulerShape>()(
  "@gram/server/HelperScheduler",
) {
  /**
   * Keys come from the gateway credentials the RPC layer installs once the key vault exists; until
   * then, and where no credentials are provided (tests), every job is skipped for want of a key.
   */
  static readonly layer = Layer.effect(
    HelperScheduler,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const helperStore = yield* makeHelperStore;
      const credentials = yield* Effect.serviceOption(GatewayCredentials);
      const activity = yield* Effect.serviceOption(AppActivity);
      const hosts = yield* Effect.serviceOption(AgentHosts);
      return yield* makeHelperScheduler({
        store,
        helperStore,
        // The lookup names an agent only for its error message, which is dropped here.
        key: (profile) =>
          Option.isNone(credentials)
            ? Effect.succeed(Option.none())
            : credentials.value.provider.credentials(profile.id, "claude").pipe(
                Effect.map(({ key }) => Option.some(key)),
                Effect.catch(() => Effect.succeed(Option.none())),
              ),
        activity: Option.getOrUndefined(activity),
        local: Option.isNone(hosts) ? undefined : localHelperTransport(hosts.value),
      });
    }),
  );
}
