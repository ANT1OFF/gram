import type {
  BoundPr,
  GitState,
  PlanStep,
  PlanStepPr,
  PrStatus,
  Thread,
  ThreadId,
  ThreadPlan,
} from "@gram/contracts";
import { repoFromPrUrl } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { ThreadPlans } from "./service.ts";

/**
 * The facts about a thread's PRs, applied to its plan whoever wrote a step: a merged PR makes its
 * step done, and one that reopened makes it `doing` again.
 */

/** A PR as the thread's git state knows it. */
export interface PrFact {
  readonly number: number;
  readonly repo?: string | undefined;
  readonly state: "open" | "draft" | "merged" | "closed";
}

const prFact = (badge: PrStatus, repo: string | undefined): PrFact => ({
  number: badge.number,
  ...(repo === undefined ? {} : { repo: repo.toLowerCase() }),
  state:
    badge.state === "MERGED"
      ? "merged"
      : badge.state === "CLOSED"
        ? "closed"
        : badge.isDraft
          ? "draft"
          : "open",
});

const followedBy = (followed: ReadonlyArray<BoundPr>, badge: PrStatus): BoundPr | undefined =>
  followed.find(
    (pr) =>
      pr.number === badge.number &&
      badge.url.toLowerCase().includes(`/${pr.repo.toLowerCase()}/pull/`),
  );

/** The facts about a thread's PRs, from its git state: the checkout's PR first. */
export const prFactsOf = (
  git: Pick<GitState, "pr" | "extraPrs"> | undefined,
  followed: ReadonlyArray<BoundPr>,
): ReadonlyArray<PrFact> =>
  [...(git?.pr === undefined ? [] : [git.pr]), ...(git?.extraPrs ?? [])].map((badge) =>
    prFact(badge, followedBy(followed, badge)?.repo ?? repoFromPrUrl(badge.url)),
  );

/**
 * The fact about the PR a step names. Numbers are local to a repository, so a step naming its repo
 * matches only that repo's PR; one naming none means the thread's own, which is the first fact (the
 * checkout's PR) or else the only one with that number. Two PRs of that number elsewhere are no
 * match at all rather than a guess.
 */
export const factOf = (pr: PlanStepPr, prs: ReadonlyArray<PrFact>): PrFact | undefined => {
  const numbered = prs.filter((p) => p.number === pr.number);
  if (pr.repo !== undefined) {
    const repo = pr.repo.toLowerCase();
    return numbered.find((p) => p.repo === repo);
  }
  if (prs[0]?.number === pr.number) return prs[0];
  return numbered.length === 1 ? numbered[0] : undefined;
};

const withPrFact = (step: PlanStep, prs: ReadonlyArray<PrFact>): PlanStep => {
  if (step.pr === undefined || step.status === "dropped") return step;
  const pr = factOf(step.pr, prs);
  if (pr === undefined) return step;
  const merged = `#${pr.number} merged`;
  if (pr.state === "merged" && step.status !== "done") {
    return { ...step, status: "done", evidence: merged };
  }
  if (pr.state !== "merged" && step.status === "done" && step.evidence === merged) {
    const { evidence: _evidence, ...rest } = step;
    return { ...rest, status: "doing" };
  }
  return step;
};

/** `plan` with the facts about its PRs applied; the same plan when nothing changes. */
export const applyPrFacts = (
  plan: ThreadPlan | undefined,
  prs: ReadonlyArray<PrFact>,
): ThreadPlan | undefined => {
  if (plan === undefined) return undefined;
  const steps = plan.steps.map((step) => withPrFact(step, prs));
  return steps.every((step, i) => step === plan.steps[i]) ? plan : { ...plan, steps };
};

const followedOf = (thread: Thread) => [
  ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
  ...(thread.extraPrs ?? []),
];

const prKey = (prs: ReadonlyArray<PrFact>): string =>
  prs.map((pr) => `${pr.repo ?? ""}#${pr.number}:${pr.state}`).join(",");

/** Applies a thread's PR facts to its plan as its git state changes. */
export const PlanPrFactsLive: Layer.Layer<
  never,
  never,
  EventHub | ThreadPlans | GitStatePublisher
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const hub = yield* EventHub;
    const plans = yield* ThreadPlans;
    const publisher = yield* GitStatePublisher;
    const seen = new Map<ThreadId, string>();

    const onState = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        if (thread.role !== undefined) return;
        const facts = prFactsOf(state, followedOf(thread));
        const key = prKey(facts);
        if (seen.get(thread.id) === key) return;
        seen.set(thread.id, key);
        yield* plans.update(thread.id, (plan) => applyPrFacts(plan, facts));
      }).pipe(Effect.catchCause(() => Effect.void));

    yield* publisher.observe({ onState, onRound: () => Effect.void }, { replay: true });

    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.runForEach((event) =>
        event.type === "thread.removed"
          ? Effect.sync(() => void seen.delete(event.threadId))
          : Effect.void,
      ),
      Effect.forkScoped,
    );
  }),
);
