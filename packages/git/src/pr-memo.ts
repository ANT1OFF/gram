/**
 * How long a PR's review threads are reused before they ride a sweep again. A thread someone opens
 * or replies to moves the PR's `updatedAt`, which refetches them at once; resolving one on
 * github.com may not, and this is how long that can go unseen.
 */
export const THREADS_MAX_AGE_MS = 120_000;

const CALLERS_MAX = 256;

interface CarriedThreads {
  readonly threads: unknown;
  readonly stamp: string;
  readonly at: number;
}

/**
 * What one resolver remembers for one caller: the PR each branch last resolved to, so its full
 * fields can ride the same document as the candidates it is chosen from, and each PR's review
 * threads, so they needn't.
 */
export interface CallerPrMemo {
  readonly known: Map<string, number>;
  readonly threads: Map<string, CarriedThreads>;
}

/** A resolver's memo: the server's own (`known`, `threads`) and each other caller's (`forCaller`). */
export interface PrMemo extends CallerPrMemo {
  /** The memo of the caller `ghCallerKey` names; `""` is this one. */
  readonly forCaller: (caller: string) => CallerPrMemo;
  /** Forgets every caller's threads, for a write that may have resolved or added one. */
  readonly clear: () => void;
}

const callerMemo = (): CallerPrMemo => ({ known: new Map(), threads: new Map() });

export const makePrMemo = (): PrMemo => {
  const own = callerMemo();
  const others = new Map<string, CallerPrMemo>();
  return {
    ...own,
    forCaller: (caller) => {
      if (caller === "") return own;
      const found = others.get(caller) ?? callerMemo();
      others.delete(caller);
      others.set(caller, found);
      if (others.size > CALLERS_MAX) others.delete(others.keys().next().value!);
      return found;
    },
    clear: () => {
      own.threads.clear();
      for (const each of others.values()) each.threads.clear();
    },
  };
};
