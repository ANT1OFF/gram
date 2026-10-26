import type {
  CatchUpView,
  GitState,
  PlanStepId,
  ThreadPlan,
  HelperEventPayload,
  RecapView,
  StuckView,
  ThreadId,
  ThreadRecap,
  ThreadSummary,
} from "@gram/contracts";

/** The design's "Bump dependencies" recap, which `simulateRecap` gives `t-deps` unless told otherwise. */
export const MOCK_DEPS_RECAP: ThreadRecap = {
  recap:
    "You bumped the API's runtime dependencies and the agent fixed the two zod 4 type errors. Unit tests pass. The bump to Vite 8.3 hasn't been checked against the e2e suite yet.",
  next: "Run the e2e suite against Vite 8.3",
  replies: [
    "Run the e2e suite against Vite 8.3",
    "Commit this and open a PR",
    "Check the bundle size before and after",
  ],
};

/** `t-deps`'s checkout while it has a recap: work that isn't pushed and has no PR. */
export const MOCK_DEPS_GIT: GitState = {
  repo: true,
  branch: "chore/deps",
  worktree: true,
  head: "de9500000000000000000000000000000000de95",
  changesToken: "mock-deps-1",
  changedFiles: 14,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 2,
  conflicts: false,
  origin: "example/api",
};

/** `t-deps`'s plan while it has a recap: two of its three steps done. */
export const MOCK_DEPS_PLAN: ThreadPlan = {
  goal: "Bump the API's dependencies",
  steps: [
    { id: "s1" as PlanStepId, text: "Bump runtime dependencies", status: "done", source: "agent" },
    { id: "s2" as PlanStepId, text: "Fix the zod 4 type errors", status: "done", source: "agent" },
    { id: "s3" as PlanStepId, text: "Run e2e against Vite 8.3", status: "todo", source: "helper" },
  ],
  basis: "",
  updatedAt: 0,
  updatedBy: "helper",
};

const BUSY = new Set<ThreadSummary["status"]>([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

/**
 * The mock's recaps: none until a spec sets one with `simulateRecap`, since a card above the
 * composer would move what every other spec reads there. A recap is served like the server's, only
 * while the thread is idle and nothing happened in it since.
 */
export function createMockAssist() {
  const recaps = new Map<ThreadId, { view: RecapView; delayMs: number }>();
  const events: HelperEventPayload[] = [];
  const catchUps = new Map<ThreadId, CatchUpView>();
  const stucks = new Map<ThreadId, StuckView>();
  return {
    simulate: (view: RecapView, delayMs: number) =>
      void recaps.set(view.threadId, { view, delayMs }),
    recap: async (summary: ThreadSummary): Promise<RecapView | null> => {
      const entry = recaps.get(summary.thread.id);
      if (entry === undefined) return null;
      await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
      if (BUSY.has(summary.status) || summary.thread.lastActivityAt > entry.view.lastActiveAt) {
        return null;
      }
      return entry.view;
    },
    /** Arms the helper's catch-up for a worker; none is armed unless a scenario asks. */
    simulateCatchUp: (view: CatchUpView) => void catchUps.set(view.threadId, view),
    /** As the server's: only while the worker hasn't been looked at since the report it covers. */
    catchUp: async (summary: ThreadSummary): Promise<CatchUpView | null> => {
      const view = catchUps.get(summary.thread.id);
      if (view === undefined) return null;
      const seen = summary.thread.lastViewedAt;
      return seen !== undefined && seen >= view.reportAt ? null : view;
    },
    /** Arms "Why is it stuck?" for a worker; none is armed unless a scenario asks. */
    simulateStuck: (view: StuckView) => void stucks.set(view.threadId, view),
    /** As the server's: the facts always, the helper's sentence only while its switch is on. */
    whyStuck: async (summary: ThreadSummary, helperOn: boolean): Promise<StuckView | null> => {
      const view = stucks.get(summary.thread.id);
      if (view === undefined || BUSY.has(summary.status)) return null;
      if (helperOn) return view;
      const { text: _helper, ...facts } = view;
      return facts;
    },
    record: (event: HelperEventPayload) => void events.push(event),
    /** Every event recorded, oldest first. */
    events: (): readonly HelperEventPayload[] => events,
  };
}
