import { validCodexCounts } from "@gram/agents/codex";
import type { TokenUsage } from "@gram/contracts";

const limit = 50_000;
const keys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const zero = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});
type Threshold = Partial<Record<(typeof keys)[number], number>>;
interface Scope {
  order?: number;
  before?: Threshold;
  required?: Threshold;
  /** Actual start counter, or a conservative requirement derived from observed counter evidence. */
  barrier?: TokenUsage;
  requests: TokenUsage;
  /** Observed native turn requirements constrain coverage, never mint request amounts. */
  minimum?: Threshold;
  counter?: TokenUsage;
}

const meets = (counter: TokenUsage | undefined, minimum: Threshold | undefined) =>
  counter !== undefined &&
  keys.every(
    (key) =>
      (minimum?.[key] ?? 0) === 0 ||
      (counter[key] !== undefined && counter[key]! >= (minimum?.[key] ?? 0)),
  );

/** Independent requests constrain coverage; these requirements never become session counters or amounts. */
export function makeCodexHistoryCoverage() {
  const scopes = new Map<string, Scope>(),
    requests = new Map<string, string>();
  const ordered: string[] = [];
  const changed = new Map<string, boolean>();
  const mark = (turn: string, allocations: boolean) =>
    changed.set(turn, allocations || changed.get(turn) === true);
  let dirtyFrom: number | undefined,
    work = 0,
    refused = false,
    unprovenFrom: number | undefined;
  const refuse = (from: number) => {
    refused = true;
    // Refusal affects this uncertain suffix, never unrelated established prefixes.
    if (unprovenFrom !== undefined && unprovenFrom <= from) return;
    const end = Math.min(ordered.length, (unprovenFrom ?? ordered.length) + 1);
    unprovenFrom = from;
    // Notify only newly uncertain positions (including the former boundary).
    // Repeated refusals cannot repeatedly traverse an already uncertain suffix.
    for (let i = from; i < end; i++) mark(ordered[i]!, i > from);
  };
  const charge = (from: number) => {
    if (work >= limit) {
      refuse(from);
      return false;
    }
    work++;
    return true;
  };
  const invalidate = (state: Scope) => {
    if (state.order !== undefined) dirtyFrom = Math.min(dirtyFrom ?? state.order, state.order);
  };
  const recompute = () => {
    if (dirtyFrom === undefined) return;
    let preceding: Threshold =
      dirtyFrom === 0 ? {} : (scopes.get(ordered[dirtyFrom - 1]!)!.required ?? {});
    for (let i = dirtyFrom; i < ordered.length; i++) {
      // Bound replay/late-evidence repair work as well as retained metadata.
      const state = scopes.get(ordered[i]!)!;
      if (!charge(i)) {
        // Failed preceding-requirement repair is not merely a completeness change.
        // Preserve unrelated established prefixes; retire this boundary's stale proof
        // only when the newly preceding evidence differs from its cached evidence.
        if (JSON.stringify(state.before) !== JSON.stringify(preceding)) {
          delete state.before;
          mark(ordered[i]!, true);
        }
        dirtyFrom = undefined;
        return;
      }
      if (JSON.stringify(state.before) !== JSON.stringify(preceding)) mark(ordered[i]!, true);
      state.before = preceding;
      const required: Threshold = {};
      for (const key of keys) {
        const base = Math.max(preceding[key] ?? 0, state.barrier?.[key] ?? 0);
        const needed = Math.max(state.requests[key] ?? 0, state.minimum?.[key] ?? 0);
        const n = base + needed;
        if (!Number.isSafeInteger(n)) {
          refuse(i);
          dirtyFrom = undefined;
          return;
        }
        if (base > 0 || state.requests[key] !== undefined || state.minimum?.[key] !== undefined)
          required[key] = n;
      }
      if (JSON.stringify(state.required) !== JSON.stringify(required)) mark(ordered[i]!, false);
      state.required = required;
      preceding = required;
    }
    dirtyFrom = undefined;
  };
  const scope = (turn: string) => {
    const old = scopes.get(turn);
    if (old !== undefined) return old;
    if (scopes.size >= limit) {
      refuse(ordered.length);
      return undefined;
    }
    const next: Scope = { requests: zero() };
    scopes.set(turn, next);
    return next;
  };
  return {
    requirement(turn: string, expected: TokenUsage) {
      const state = scope(turn);
      if (state === undefined) return;
      if (!validCodexCounts(expected)) {
        refuse(state.order ?? ordered.length);
        return;
      }
      const minimum = Object.fromEntries(
        keys.flatMap((key) =>
          state.minimum?.[key] === undefined && expected[key] === undefined
            ? []
            : [[key, Math.max(state.minimum?.[key] ?? 0, expected[key] ?? 0)]],
        ),
      ) as Threshold;
      if (JSON.stringify(minimum) === JSON.stringify(state.minimum)) return;
      state.minimum = minimum;
      invalidate(state);
    },
    start(turn: string, counter: TokenUsage | undefined) {
      const state = scope(turn);
      if (state === undefined) return;
      if (state.order === undefined) {
        state.order = ordered.length;
        ordered.push(turn);
      }
      if (state.barrier === undefined && counter !== undefined) state.barrier = counter;
      invalidate(state);
    },
    counted(turn: string, counter: TokenUsage | undefined, known: TokenUsage | undefined) {
      const state = scope(turn);
      if (state === undefined) return;
      if (counter !== undefined && JSON.stringify(state.counter) !== JSON.stringify(counter)) {
        state.counter = counter;
        mark(turn, false);
      }
      if (state.barrier !== undefined || counter === undefined) return;
      // Subtract only a proven contribution. With an unknown start this may overestimate
      // the necessary covering counter; it never invents an attributable amount.
      const barrier: Record<string, number> = {};
      for (const key of keys) {
        if (counter[key] === undefined) continue;
        const difference = counter[key]! - (known?.[key] ?? 0);
        if (!Number.isSafeInteger(difference) || difference < 0) {
          refuse(state.order ?? ordered.length);
          return;
        }
        barrier[key] = difference;
      }
      const next = barrier as unknown as TokenUsage;
      if (!validCodexCounts(next)) {
        refuse(state.order ?? ordered.length);
        return;
      }
      state.barrier = next;
      invalidate(state);
    },
    request(turn: string, response: string, tokens: TokenUsage, counter: TokenUsage | undefined) {
      const signature = JSON.stringify([turn, tokens]),
        prior = requests.get(response);
      if (prior !== undefined) {
        if (prior === signature) return "duplicate";
        const priorTurn = JSON.parse(prior)[0] as string;
        refuse(
          Math.min(
            scopes.get(priorTurn)?.order ?? ordered.length,
            scopes.get(turn)?.order ?? ordered.length,
          ),
        );
        return "conflict";
      }
      if (requests.size >= limit) {
        refuse(scopes.get(turn)?.order ?? ordered.length);
        return "refused";
      }
      const state = scope(turn);
      if (state === undefined) return "refused";
      // These are minimum requirements, not full amounts. Absent optional detail
      // cannot erase a positive lane already witnessed on another request.
      const combined = Object.fromEntries(
        keys.map((key) => [key, (state.requests[key] ?? 0) + (tokens[key] ?? 0)]),
      ) as unknown as TokenUsage;
      if (!validCodexCounts(combined)) {
        refuse(scopes.get(turn)?.order ?? ordered.length);
        return "refused";
      }
      // No scope start was observed: use the last actually observed counter as a
      // conservative barrier, rather than assuming this response was already included.
      const barrier = state.barrier ?? counter ?? zero();
      state.barrier = barrier;
      state.requests = combined;
      requests.set(response, signature);
      if (state.order === undefined) refuse(ordered.length);
      invalidate(state);
      return "new";
    },
    covers(counter: TokenUsage | undefined) {
      recompute();
      const last = ordered.length === 0 ? undefined : scopes.get(ordered.at(-1)!)!.required;
      return unprovenFrom === undefined && meets(counter, last);
    },
    allocationCovered(turn: string, counter: TokenUsage | undefined, ownPrefix: TokenUsage) {
      recompute();
      const state = scopes.get(turn);
      if (state?.order === undefined || state.before === undefined) return false;
      // The allocation uses preceding scopes, not later evidence/refusal in its own scope.
      if (unprovenFrom !== undefined && state.order > unprovenFrom) return false;
      const minimum: Threshold = { ...state.before };
      for (const key of keys)
        if (ownPrefix[key] !== undefined) minimum[key] = (minimum[key] ?? 0) + ownPrefix[key]!;
      return meets(counter, minimum);
    },
    scopeCovered(turn: string) {
      recompute();
      const state = scopes.get(turn);
      return (
        state === undefined ||
        state.requests.inputTokens + state.requests.outputTokens === 0 ||
        (state.order !== undefined &&
          (unprovenFrom === undefined || state.order < unprovenFrom) &&
          meets(state.counter, state.required))
      );
    },
    repairBudget(visits: number) {
      if (visits > limit - work) {
        refuse(ordered.length);
        return false;
      }
      work += visits;
      return true;
    },
    changes() {
      recompute();
      const result = [...changed];
      changed.clear();
      return result;
    },
    prefix: (turn: string) => scopes.get(turn)?.requests ?? zero(),
    overflow: () => refused,
    retainedBytes() {
      return (
        Buffer.byteLength(JSON.stringify(ordered)) +
        Buffer.byteLength(JSON.stringify([...changed])) +
        [...scopes].reduce(
          (n, [turn, state]) =>
            n + Buffer.byteLength(turn) + Buffer.byteLength(JSON.stringify(state)),
          0,
        ) +
        [...requests].reduce(
          (n, [id, signature]) => n + Buffer.byteLength(id) + Buffer.byteLength(signature),
          0,
        )
      );
    },
  };
}
