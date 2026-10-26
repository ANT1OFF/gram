import type { PrStatus } from "@gram/contracts";
import type { PrDetailResponse } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { isBadgeOf } from "./extra-prs.ts";

/** How long a PR detail answer is reused. */
export const PR_DETAIL_TTL_MS = 30_000;

export interface PrDetailRequest {
  readonly cwd: string;
  readonly number: number;
  /** `owner/repo` for a PR bound from another repo; absent means `cwd`'s origin. */
  readonly repo?: string | undefined;
  /** The PR's head commit and `updatedAt`, when known: a changed PR is a new entry. */
  readonly stamp?: string | undefined;
}

/**
 * The `stamp` for the detail of `target` (`repo` when it is bound, else the checkout's origin),
 * from the thread's own badge (`GitStatePublisher.badgeFor`). None when the badge is another PR's:
 * the checkout's PR can share a bound PR's number, and stamping from it keeps an old answer about
 * the bound one while that one merges.
 */
export const prDetailStamp = (
  badge: Pick<PrStatus, "number" | "url" | "headRefOid" | "updatedAt"> | undefined,
  target: { readonly number: number; readonly repo?: string | undefined },
): string | undefined => {
  if (badge === undefined || badge.number !== target.number) return undefined;
  if (target.repo !== undefined && !isBadgeOf(badge, { repo: target.repo, number: target.number }))
    return undefined;
  return `${badge.headRefOid ?? ""}:${badge.updatedAt ?? ""}`;
};

/**
 * `Pr.detail` answers kept for `ttlMs` per PR and stamp, so the PR panel opening right after a pane
 * gains focus (which prewarms it) doesn't run `gh pr view` and `gh pr diff` again. Callers asking for
 * the same entry while it's being fetched share that one fetch. Unavailable and failed answers
 * aren't kept.
 */
export const makePrDetailCache = (
  detail: (cwd: string, number: number, repo?: string) => Effect.Effect<PrDetailResponse>,
  ttlMs: number = PR_DETAIL_TTL_MS,
) => {
  const entries = new Map<string, { readonly at: number; readonly value: PrDetailResponse }>();
  const inFlight = new Map<string, Deferred.Deferred<PrDetailResponse>>();
  /**
   * Evicting, reading and claiming an entry in one synchronous step, which no fiber can be
   * preempted inside. Split across a `yield*`, two concurrent callers both miss the in-flight
   * check and run the fetch twice — which is the duplicate `gh` pair the cache exists to remove.
   */
  const claimUnsafe = (key: string, now: number) => {
    for (const [other, entry] of entries) {
      if (now - entry.at >= ttlMs) entries.delete(other);
    }
    const hit = entries.get(key);
    if (hit !== undefined) return { kind: "hit", value: hit.value } as const;
    const pending = inFlight.get(key);
    if (pending !== undefined) return { kind: "pending", deferred: pending } as const;
    const deferred = Deferred.makeUnsafe<PrDetailResponse>();
    inFlight.set(key, deferred);
    return { kind: "claimed", deferred } as const;
  };

  return (request: PrDetailRequest): Effect.Effect<PrDetailResponse> =>
    Effect.gen(function* () {
      const key = `${request.repo ?? request.cwd}#${request.number}@${request.stamp ?? ""}`;
      const now = yield* Clock.currentTimeMillis;
      const claim = claimUnsafe(key, now);
      if (claim.kind === "hit") return claim.value;
      if (claim.kind === "pending") return yield* Deferred.await(claim.deferred);

      const deferred = claim.deferred;
      const value = yield* detail(request.cwd, request.number, request.repo).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (inFlight.get(key) === deferred) inFlight.delete(key);
          }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
        ),
      );
      if (value.available && value.error === undefined && value.detail !== undefined) {
        entries.set(key, { at: yield* Clock.currentTimeMillis, value });
      }
      return value;
    });
};
