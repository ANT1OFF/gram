// @vitest-environment happy-dom
import {
  initialBabysitState,
  PR_STALE_SIGNED_OUT,
  type BabysitState,
  type GitState,
  type PrStatus,
  type ThreadId,
} from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render as renderBare, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { PREWARM_DWELL_MS } from "@/panels/use-pr-detail-prewarm";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  mergeStateMarkOf,
  PrBadge,
  prBadgeTitle,
  PrChip,
  prCue,
  prBadgeGlyphs,
  type PrBadgeThread,
  reviewDecisionMarkOf,
  staleReasonText,
} from "./git-badges";

const T = "t-flaky" as ThreadId;

const prDetail = vi.fn(async () => ({ available: true }));

/** `PrBadge` prewarms the PR detail, so it renders under the API and a query client. */
const render = (ui: ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderBare(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ApiProvider api={{ prDetail } as unknown as Api}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </ApiProvider>
    ),
  });
};

const pr = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 412,
  state: "OPEN",
  url: "https://github.com/example/api/pull/412",
  title: "Make the retry test deterministic",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

const git = (overrides: Partial<GitState> = {}): GitState => ({
  repo: true,
  branch: "fix/flaky-retry",
  worktree: false,
  head: "abc",
  changesToken: "tok",
  changedFiles: 0,
  base: "origin/main",
  behindBase: 0,
  aheadBase: 2,
  conflicts: false,
  upstream: "synced",
  ...overrides,
});

afterEach(cleanup);

describe("prBadgeGlyphs", () => {
  it("draws the PR's own state, then its checks", () => {
    expect(prBadgeGlyphs(pr({ checks: "failing" }))).toMatchObject({
      state: { tone: "text-success" },
      checks: { tone: "text-destructive" },
    });
    expect(prBadgeGlyphs(pr({ checks: "none" })).checks).toBeUndefined();
    expect(prBadgeGlyphs(pr({ isDraft: true, checks: "pending" }))).toMatchObject({
      state: { tone: "text-muted-foreground" },
      checks: { tone: "text-status-working" },
    });
  });

  it("leaves a merged or closed PR its one glyph", () => {
    expect(prBadgeGlyphs(pr({ state: "MERGED" }))).toMatchObject({
      state: { tone: "text-merged" },
      checks: undefined,
    });
    expect(prBadgeGlyphs(pr({ state: "CLOSED" })).checks).toBeUndefined();
  });

  it("dims a red check nobody requires, and names the badge by the required ones", () => {
    const windowsRed = pr({ checks: "failing", requiredChecks: "passing" });
    expect(prBadgeGlyphs(windowsRed).checks).toMatchObject({
      tone: "text-destructive opacity-50",
    });
    // The badge's name is its one glyph's, which goes by the checks GitHub requires.
    render(<PrBadge threadId={T} git={{ ...git(), pr: windowsRed }} testId="red-badge" />);
    expect(screen.getByTestId("red-badge").getAttribute("data-state")).toBe("ready");
    expect(screen.getByRole("img", { name: "Ready, checks passing" })).toBeTruthy();
    expect(prBadgeTitle(git(), { ...windowsRed, requiredChecks: "pending" })).toContain(
      "\nChecks running\n",
    );
  });
});

describe("stale badge", () => {
  const stale = { reason: "rate limited", since: Date.now() - 5 * 60_000 };

  it("explains in the tooltip that GitHub couldn't be reached", () => {
    const title = prBadgeTitle(git(), pr({ stale }));
    expect(title).toContain("Couldn't refresh from GitHub: rate limited");
    expect(prBadgeTitle(git(), pr())).not.toContain("Couldn't refresh");
  });

  it("keeps local GitHub sign-in guidance", () => {
    const signedOut = { reason: PR_STALE_SIGNED_OUT, since: Date.now() };
    expect(prBadgeTitle(git(), pr({ stale: signedOut }))).toContain(
      "Couldn't refresh from GitHub: not logged in to gh",
    );
    expect(staleReasonText("rate limited")).toBe("rate limited");
    expect(staleReasonText(PR_STALE_SIGNED_OUT)).toBe(PR_STALE_SIGNED_OUT);
  });

  it("marks the badge with a glyph", () => {
    render(<PrBadge threadId={T} git={{ ...git(), pr: pr({ stale }) }} testId="stale-badge" />);
    expect(screen.getByTestId("stale-badge").getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("pr-stale-glyph")).toBeTruthy();
  });
});

describe("PR chips", () => {
  it("marks what GitHub says blocks an open PR, in its merge marks' words", () => {
    expect(mergeStateMarkOf(pr({ mergeState: "DIRTY", baseRef: "main" }))).toEqual({
      kind: "conflicts",
      word: "Conflicts",
      detail: "Conflicts with main",
    });
    expect(mergeStateMarkOf(pr({ mergeState: "BEHIND" }))?.word).toBe("Out of date");
    expect(mergeStateMarkOf(pr({ mergeState: "BLOCKED" }))?.kind).toBe("blocked");
    expect(mergeStateMarkOf(pr({ mergeState: "UNSTABLE" }))?.kind).toBe("unstable");
    expect(mergeStateMarkOf(pr({ mergeState: "CLEAN" }))).toBeUndefined();
    expect(mergeStateMarkOf(pr({ mergeState: "BLOCKED", state: "MERGED" }))).toBeUndefined();
    expect(mergeStateMarkOf(pr())).toBeUndefined();
    expect(mergeStateMarkOf(undefined)).toBeUndefined();
  });

  it("leaves blocked out where the thread's merge is armed, as the merge marks do", () => {
    const blocked = pr({ mergeState: "BLOCKED" });
    const mergeWhenReady = { method: "squash", allowedBy: "user", setAt: 1 } as const;
    const armed = { repo: "example/api", number: 412, monitor: true, mergeWhenReady };
    expect(mergeStateMarkOf(blocked, armed)).toBeUndefined();
    expect(mergeStateMarkOf(pr({ mergeState: "DIRTY" }), armed)?.kind).toBe("conflicts");
  });

  it("marks people's review of a PR not yet merged or closed", () => {
    expect(reviewDecisionMarkOf(pr({ reviewDecision: "APPROVED" }))?.word).toBe("Approved");
    expect(reviewDecisionMarkOf(pr({ reviewDecision: "CHANGES_REQUESTED" }))?.word).toBe(
      "Changes requested",
    );
    expect(reviewDecisionMarkOf(pr({ reviewDecision: "REVIEW_REQUIRED" }))?.kind).toBe("waiting");
    expect(reviewDecisionMarkOf(pr({ reviewDecision: "" }))).toBeUndefined();
    expect(
      reviewDecisionMarkOf(pr({ reviewDecision: "APPROVED", state: "CLOSED" })),
    ).toBeUndefined();
  });

  it("renders an icon and the mark's word with its detail as its tooltip", () => {
    render(
      <PrChip
        group="merge"
        mark={mergeStateMarkOf(pr({ mergeState: "BEHIND", baseRef: "main" }))}
        testId="chip"
      />,
    );
    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("Out of date");
    expect(chip.getAttribute("data-state")).toBe("behind");
    expect(chip.getAttribute("title")).toBe("Behind main");
  });
});

describe("PrChip iconOnly", () => {
  it("keeps the word for screen readers and says it with its detail on hover", async () => {
    render(
      <PrChip
        group="merge"
        mark={mergeStateMarkOf(pr({ mergeState: "BLOCKED" }))}
        testId="chip"
        iconOnly
      />,
    );
    const chip = screen.getByTestId("chip");
    expect(chip.textContent).toBe("Blocked");
    expect(chip.querySelector(".sr-only")?.textContent).toBe("Blocked");
    fireEvent.mouseEnter(chip);
    fireEvent.focus(chip);
    expect(await screen.findByText("Blocked: Required reviews or checks are missing")).toBeTruthy();
  });
});

describe("PrBadge", () => {
  beforeEach(() => {
    useLayoutStore.setState({ panelOpen: false, panelTab: "diff", focusMode: true });
  });

  it("warns when uncommitted work sits in another worktree", () => {
    const state = git({
      pr: pr(),
      workElsewhere: { branch: "feat/wip", path: "/repo/.worktrees/wip" },
    });
    render(<PrBadge threadId={T} git={state} testId="pr-badge" />);
    expect(
      screen.getByRole("img", { name: "uncommitted work on feat/wip in another worktree" }),
    ).toBeTruthy();
    expect(screen.getByTestId("pr-badge").getAttribute("title")).toContain(
      "⚠  uncommitted work on “feat/wip” in another worktree (/repo/.worktrees/wip)",
    );
  });

  it("drops the outline and the number in a sidebar row, but never a cue's dashes", () => {
    const { rerender } = render(
      <PrBadge threadId={T} git={git({ pr: pr() })} testId="pr-badge" bare numbered={false} />,
    );
    const badge = screen.getByTestId("pr-badge");
    expect(badge.className).not.toContain("border");
    expect(badge.textContent).toBe("#412");
    expect(badge.querySelector(".sr-only")?.textContent).toBe("#412");

    const followed = {
      checkout: { kind: "worktree", path: "/repo/.worktrees/a", branch: "a" },
      currentCheckout: { kind: "worktree", path: "/repo/.worktrees/b", branch: "b" },
    } as PrBadgeThread;
    rerender(
      <PrBadge threadId={T} git={git({ pr: pr() })} thread={followed} testId="pr-badge" bare />,
    );
    expect(screen.getByTestId("pr-badge").className).toContain("border-dashed");
  });

  it("marks local commits past the PR head, except while diverged", () => {
    const ahead = pr({ aheadOfPr: true });
    const { rerender } = render(
      <PrBadge threadId={T} git={git({ pr: ahead })} testId="pr-badge" />,
    );
    expect(screen.getByTestId("pr-badge").textContent).toBe("#412+");
    expect(screen.getByRole("img", { name: "Ready, checks passing" })).toBeTruthy();
    rerender(
      <PrBadge threadId={T} git={git({ upstream: "diverged", pr: ahead })} testId="pr-badge" />,
    );
    expect(screen.getByTestId("pr-badge").textContent).toBe("#412");
    expect(prBadgeTitle(git({ pr: ahead }), ahead)).toBe(
      "#412 Make the retry test deterministic\nReady, checks passing\n+  commits past the PR head, not in the PR\nOpens the PR panel",
    );
  });

  it("paints a bound PR's merge only when it has the thread, as the pane header and row both do", () => {
    const merged = pr({ state: "MERGED", headMatches: false });
    const checkout = { kind: "main" as const, path: "/repo" };
    const { rerender } = render(
      <PrBadge threadId={T} git={git({ pr: merged })} testId="pane-pr-badge" />,
    );
    expect(screen.getByTestId("pane-pr-badge").dataset["state"]).toBe("ready");
    rerender(
      <PrBadge
        threadId={T}
        git={git({ pr: merged })}
        thread={{ checkout, boundPr: { repo: "example/api", number: 412, monitor: false } }}
        testId="pane-pr-badge"
      />,
    );
    expect(screen.getByTestId("pane-pr-badge").dataset["state"]).toBe("merged");
  });

  it("marks a followed worktree with a dashed border and a bound PR elsewhere with →", () => {
    const launch = { kind: "worktree" as const, path: "/repo/.worktrees/a", branch: "feat/a" };
    const moved = { kind: "worktree" as const, path: "/repo/.worktrees/b", branch: "feat/b" };
    expect(prCue({ checkout: launch }, pr())).toBeUndefined();
    expect(prCue({ checkout: launch, currentCheckout: launch }, pr())).toBeUndefined();
    expect(prCue({ checkout: launch, currentCheckout: moved }, pr())).toBe("followed");
    const bound = { repo: "example/api", number: 400, monitor: false };
    expect(prCue({ checkout: launch, boundPr: { ...bound, number: 412 } }, pr())).toBeUndefined();
    expect(prCue({ checkout: launch, currentCheckout: moved, boundPr: bound }, pr())).toBe(
      "elsewhere",
    );

    const { rerender } = render(
      <PrBadge
        threadId={T}
        git={git({ pr: pr() })}
        thread={{ checkout: launch, currentCheckout: moved }}
        testId="pr-badge"
      />,
    );
    const badge = screen.getByTestId("pr-badge");
    expect(badge.dataset["cue"]).toBe("followed");
    expect(badge.className).toContain("border-dashed");
    expect(badge.getAttribute("title")).toContain(
      "Dashed: followed the agent to feat/b, launched on feat/a",
    );
    expect(badge.textContent).toContain("followed the agent into another worktree");

    rerender(
      <PrBadge
        threadId={T}
        git={git({ pr: pr() })}
        thread={{ checkout: launch, boundPr: bound }}
        testId="pr-badge"
      />,
    );
    expect(screen.getByTestId("pr-badge").dataset["cue"]).toBe("elsewhere");
    expect(screen.getByRole("img", { name: "bound to #400" })).toBeTruthy();
    expect(screen.getByTestId("pr-badge").getAttribute("title")).toContain(
      "→  this thread is bound to #400, not this branch's PR",
    );
  });

  it("shows a bound PR as merged even once the branch no longer matches its head", () => {
    const merged = pr({ state: "MERGED", headMatches: false });
    const launch = { kind: "worktree" as const, path: "/repo/.worktrees/a", branch: "feat/a" };
    const { rerender } = render(
      <PrBadge threadId={T} git={git({ pr: merged })} thread={{ checkout: launch }} testId="b" />,
    );
    expect(screen.getByTestId("b").dataset["state"]).not.toBe("merged");

    const boundPr = { repo: "example/api", number: merged.number, monitor: false };
    rerender(
      <PrBadge
        threadId={T}
        git={git({ pr: merged })}
        thread={{ checkout: launch, boundPr }}
        testId="b"
      />,
    );
    expect(screen.getByTestId("b").dataset["state"]).toBe("merged");
    expect(screen.getByRole("img", { name: "Merged" })).toBeTruthy();

    // Numbers are local to a repository: the same number bound in another one anchors nothing.
    rerender(
      <PrBadge
        threadId={T}
        git={git({ pr: merged })}
        thread={{ checkout: launch, boundPr: { ...boundPr, repo: "example/infra" } }}
        testId="b"
      />,
    );
    expect(screen.getByTestId("b").dataset["state"]).not.toBe("merged");
  });

  it("carries the bot glyph and renders nothing without a PR", () => {
    const review = {
      bots: ["example-code-review"],
      reviewedHead: true,
      roundInFlight: false,
      threads: { unresolved: 2, blockers: 2, suggestions: 0, outdatedUnresolved: 0 },
    };
    render(<PrBadge threadId={T} git={git({ pr: pr({ review }) })} testId="pr-badge" />);
    expect(screen.getByRole("img", { name: "Review bot: 2 blockers" })).toBeTruthy();
    cleanup();
    const { container } = render(<PrBadge threadId={T} git={git()} testId="pr-badge" />);
    expect(container.textContent).toBe("");
  });

  it("shows the babysit phase beside the PR number", () => {
    const withBabysit = (babysit: BabysitState) =>
      act(() => {
        useThreadsStore.setState({ byId: { [T]: { thread: { id: T, babysit } } as never } });
      });
    render(<PrBadge threadId={T} git={git({ pr: pr() })} testId="pr-badge" />);
    expect(screen.queryByTestId("babysit-glyph")).toBeNull();

    withBabysit({ ...initialBabysitState(0), rounds: 2 });
    expect(screen.getByRole("img", { name: "Babysitting · round 2 of 6" })).toBeTruthy();
    withBabysit({ ...initialBabysitState(0), phase: "stopped", stopReason: "forcePush" });
    expect(
      screen.getByRole("img", { name: "Babysit stopped: force-push detected" }).dataset["phase"],
    ).toBe("stopped");
    act(() => useThreadsStore.setState({ byId: {} }));
  });

  it("opens the PR panel on click or Enter, leaving focus mode", () => {
    render(<PrBadge threadId={T} git={git({ pr: pr() })} testId="pr-badge" />);
    fireEvent.click(screen.getByTestId("pr-badge"));
    expect(useLayoutStore.getState()).toMatchObject({
      panelOpen: true,
      panelTab: "pr",
      focusMode: false,
    });

    useLayoutStore.setState({ panelOpen: false, panelTab: "files" });
    fireEvent.keyDown(screen.getByTestId("pr-badge"), { key: "Enter" });
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: "pr" });
  });

  it("fetches the PR detail once the pointer rests on it, not as it passes", async () => {
    vi.useFakeTimers();
    try {
      const state = git({ pr: pr() });
      useThreadsStore.setState({ byId: { [T]: { thread: { id: T }, git: state } as never } });
      render(<PrBadge threadId={T} git={state} testId="pr-badge" />);
      const badge = screen.getByTestId("pr-badge");

      fireEvent.pointerEnter(badge);
      fireEvent.pointerLeave(badge);
      await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
      expect(prDetail).not.toHaveBeenCalled();

      fireEvent.pointerEnter(badge);
      await vi.advanceTimersByTimeAsync(PREWARM_DWELL_MS);
      expect(prDetail).toHaveBeenCalledExactlyOnceWith(T);
    } finally {
      vi.useRealTimers();
      useThreadsStore.setState({ byId: {} });
    }
  });
});
