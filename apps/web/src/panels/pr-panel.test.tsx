// @vitest-environment happy-dom
import { NotImplemented, type PrDetailResult, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockGitState, mockPrDetail } from "@/api/mock-git";
import { MockReviews } from "@/api/mock-review";
import { revealLabel } from "@/editor/use-open-in-editor";
import type * as Motion from "@/motion";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import {
  checkDuration,
  checkState,
  commitUrl,
  descriptionPreview,
  newlyFailing,
  PrPanel,
} from "./pr-panel";
import { Remount, renderWithApi } from "./test-utils";

vi.mock("@/motion", async (original) => ({
  ...(await original<typeof Motion>()),
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}));

const T = "t-flaky" as ThreadId;

const withResult = (result: PrDetailResult) => ({ prDetail: vi.fn(async () => result) });

/** The thread's store entry with a PR badge stamped `updatedAt`. */
const pr = (updatedAt: string) =>
  ({
    thread: { checkout: { path: "/repo" } },
    git: {
      origin: "example/api",
      pr: {
        number: 412,
        url: "https://github.com/example/api/pull/412",
        updatedAt,
        checks: "failing",
      },
    },
  }) as never;

const checkRun = (name: string, status: "passing" | "failing" | "pending") => ({
  name,
  status,
  link: "",
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useLayoutStore.setState({ prPanelTab: "overview" });
});

describe("PrPanel", () => {
  it("explains a missing or logged-out GitHub CLI", async () => {
    renderWithApi(<PrPanel threadId={T} />, withResult({ available: false }));
    expect(await screen.findByText("GitHub CLI not available or logged out")).toBeTruthy();
  });

  it("says when the branch has no PR, and offers Refresh", async () => {
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => ({ available: true }));
    const refreshGit = vi.fn(async () => {});
    renderWithApi(<PrPanel threadId={T} />, { prDetail, refreshGit });
    expect(await screen.findByText("No PR for this branch")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    await waitFor(() => expect(prDetail).toHaveBeenCalledTimes(2));
    expect(refreshGit).toHaveBeenCalledWith(T);
  });

  it("doesn't ask again for a thread with no PR on a remount, but does for one with a PR", async () => {
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => ({ available: true }));
    renderWithApi(
      <Remount>
        <PrPanel threadId={T} />
      </Remount>,
      { prDetail },
    );
    expect(await screen.findByText("No PR for this branch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remount" }));
    expect(await screen.findByText("No PR for this branch")).toBeTruthy();
    expect(prDetail).toHaveBeenCalledTimes(1);

    act(() => useThreadsStore.setState({ byId: { [T]: pr("2026-01-01T00:00:00Z") } }));
    await waitFor(() => expect(prDetail).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Remount" }));
    await waitFor(() => expect(prDetail).toHaveBeenCalledTimes(3));
  });

  it("asks again for a thread with no PR once a while has passed, or when gh was missing", async () => {
    const prDetail = vi
      .fn<() => Promise<PrDetailResult>>()
      .mockResolvedValueOnce({ available: false })
      .mockResolvedValue({ available: true });
    renderWithApi(
      <Remount>
        <PrPanel threadId={T} />
      </Remount>,
      { prDetail },
    );
    expect(await screen.findByText("GitHub CLI not available or logged out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remount" }));
    expect(await screen.findByText("No PR for this branch")).toBeTruthy();
    expect(prDetail).toHaveBeenCalledTimes(2);

    // The server finds a PR the badge missed, so "no PR" stands only for a while.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      fireEvent.click(screen.getByRole("button", { name: "Remount" }));
      await waitFor(() => expect(prDetail).toHaveBeenCalledTimes(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the PR header, checks, commits, conversation and files", async () => {
    renderWithApi(<PrPanel threadId={T} />, withResult(mockPrDetail(T)));

    const panel = await screen.findByTestId("pr-panel");
    expect(within(panel).getByText("Make the retry test deterministic")).toBeTruthy();
    expect(within(panel).getByTestId("review-decision").textContent).toBe("Changes requested");
    expect(within(panel).getByTestId("pr-author").textContent).toBe("by alex");
    expect(within(panel).getByTestId("pr-reviews").textContent).toBe("1 review");
    expect(within(panel).queryByTestId("pr-merge-state")).toBeNull();
    expect(within(panel).getByRole("list", { name: "Reviewers" }).textContent).toContain(
      "maria: Review requested",
    );
    expect(
      within(panel)
        .getByRole("link", { name: /Open on GitHub/ })
        .getAttribute("href"),
    ).toBe("https://github.com/example/api/pull/412");

    const checks = within(panel).getByRole("region", { name: "Checks" });
    expect(within(checks).getByRole("heading").textContent).toBe("Checks2/4 passing");
    expect(within(checks).getByText("Failing")).toBeTruthy();
    expect(within(checks).getByText("Running")).toBeTruthy();
    expect(within(checks).getByText("5m 12s")).toBeTruthy();

    const commits = within(panel).getByRole("region", { name: "Commits" });
    // Folded until asked for, with the count in its heading.
    expect(within(commits).getByRole("heading").textContent).toBe("Commits2");
    fireEvent.click(within(commits).getByRole("button", { name: /Commits/, expanded: false }));
    expect(within(commits).getByText("3f9c2d1")).toBeTruthy();
    expect(within(commits).getAllByText("alex")).toHaveLength(2);

    const conversation = within(panel).getByRole("region", { name: "Conversation" });
    expect(within(conversation).getByText("reviewer")).toBeTruthy();

    expect(within(panel).getAllByTestId("diff-file")).toHaveLength(1);
  });

  it("folds the description to a preview until it is opened", async () => {
    renderWithApi(<PrPanel threadId={T} />, withResult(mockPrDetail(T)));
    const panel = await screen.findByTestId("pr-panel");
    expect(within(panel).getByTestId("pr-description-preview").textContent).toBe(
      "Switches retry.test.ts to the fake clock, so the retry ordering no longer depends on a real 100 ms timer.",
    );
    expect(within(panel).queryByTestId("pr-description")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Description" }));
    expect(within(panel).getByTestId("pr-description")).toBeTruthy();
    expect(within(panel).queryByTestId("pr-description-preview")).toBeNull();
  });

  it("previews a description as plain text", () => {
    expect(
      descriptionPreview(
        "<!-- template -->\n## Summary\n- Uses **the** [fake clock](https://x.dev) in `retry`\n\n```ts\nx()\n```\nDone.",
      ),
    ).toBe("Summary Uses the fake clock in retry Done.");
  });

  it("opens the checks when one starts failing, after the user folded them", async () => {
    const passing = mockPrDetail(T);
    const all = passing.detail!.checkRuns.map((run) => ({ ...run, status: "passing" as const }));
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => ({
      ...passing,
      detail: { ...passing.detail!, checkRuns: all },
    }));
    renderWithApi(<PrPanel threadId={T} />, { prDetail, refreshGit: vi.fn(async () => {}) });
    const checks = within(await screen.findByTestId("pr-panel")).getByRole("region", {
      name: "Checks",
    });
    fireEvent.click(within(checks).getByRole("button", { name: /Checks/, expanded: true }));
    expect(within(checks).queryAllByTestId("check-run")).toHaveLength(0);

    prDetail.mockImplementation(async () => mockPrDetail(T));
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    await waitFor(() =>
      expect(within(checks).getAllByTestId("check-run").length).toBeGreaterThan(0),
    );
  });

  it("shows the badge's merge state in the header when the badge is this PR", async () => {
    useThreadsStore.setState({
      byId: {
        [T]: { thread: { checkout: { path: "/repo" } }, git: mockGitState(T, undefined) },
      } as never,
    });
    renderWithApi(<PrPanel threadId={T} />, withResult(mockPrDetail(T)));
    const chip = await screen.findByTestId("pr-merge-state");
    expect(chip.textContent).toBe("Blocked");
  });

  it("drops the previous PR's detail and actions while a newly bound PR loads", async () => {
    const git = mockGitState(T, undefined);
    const thread = { checkout: { path: "/repo" } };
    useThreadsStore.setState({ byId: { [T]: { thread, git } } as never });
    const second = Promise.withResolvers<PrDetailResult>();
    const prDetail = vi
      .fn()
      .mockResolvedValueOnce(mockPrDetail(T))
      .mockReturnValueOnce(second.promise);
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), prDetail });
    await screen.findByTestId("pr-panel");

    act(() => {
      const boundPr = { repo: "example/infra", number: 88, monitor: false };
      useThreadsStore.setState({ byId: { [T]: { thread: { ...thread, boundPr }, git } } as never });
    });
    await waitFor(() => expect(prDetail).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("pr-panel")).toBeNull();
    expect(screen.getByText("Loading pull request…")).toBeTruthy();
    second.resolve(mockPrDetail(T));
  });

  it("says when the badge couldn't refresh from GitHub, and offers Refresh", async () => {
    const git = mockGitState(T, undefined)!;
    useThreadsStore.setState({
      byId: {
        [T]: {
          thread: { checkout: { path: "/repo" } },
          git: { ...git, pr: { ...git.pr!, stale: { reason: "rate limited", since: 1 } } },
        },
      } as never,
    });
    const refreshGit = vi.fn(async () => {});
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), refreshGit });

    const stale = await screen.findByTestId("pr-stale");
    expect(stale.textContent).toContain("Couldn't refresh from GitHub: rate limited");
    fireEvent.click(within(stale).getByRole("button", { name: "Refresh" }));
    expect(refreshGit).toHaveBeenCalledWith(T);
  });

  it("updates an out-of-date branch from its merge-state chip", async () => {
    const git = mockGitState(T, undefined)!;
    useThreadsStore.setState({
      byId: {
        [T]: {
          thread: { checkout: { path: "/repo" } },
          git: { ...git, pr: { ...git.pr!, mergeState: "BEHIND" } },
        },
      } as never,
    });
    const prUpdateBranch = vi.fn(async () => {});
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), prUpdateBranch });

    expect((await screen.findByTestId("pr-merge-state")).textContent).toBe("Out of date");
    fireEvent.click(screen.getByRole("button", { name: "Update branch" }));
    await waitFor(() => expect(prUpdateBranch).toHaveBeenCalledWith(T));
    expect(await screen.findByText("Updating #412 with main.")).toBeTruthy();
  });

  it("finds the checks that turned failing, not the ones that already were or are new", () => {
    const prev = [
      checkRun("lint", "passing"),
      checkRun("e2e", "pending"),
      checkRun("unit", "failing"),
    ];
    const next = [
      checkRun("lint", "passing"),
      checkRun("e2e", "failing"),
      checkRun("unit", "failing"),
      checkRun("build", "failing"),
    ];
    expect(newlyFailing(prev, next)).toEqual(["e2e"]);
  });

  it("tells queued, running and cancelled checks apart, with durations", () => {
    const run = { name: "test", link: "" } as const;
    expect(checkState({ ...run, status: "pending", phase: "queued" }).label).toBe("Queued");
    expect(checkState({ ...run, status: "pending", phase: "running" }).label).toBe("Running");
    expect(checkState({ ...run, status: "pending" }).label).toBe("Pending");
    expect(checkState({ ...run, status: "pending", phase: "running" }).spin).toBe(true);
    expect(checkState({ ...run, status: "pending", phase: "queued" }).spin).toBeUndefined();
    expect(checkState({ ...run, status: "neutral", conclusion: "CANCELLED" }).label).toBe(
      "Cancelled",
    );
    expect(checkState({ ...run, status: "failing", phase: "completed" }).label).toBe("Failing");

    const startedAt = "2026-09-16T10:00:00Z";
    expect(checkDuration({ ...run, status: "pending" })).toBeUndefined();
    expect(
      checkDuration({ ...run, status: "passing", startedAt, completedAt: "2026-09-16T10:00:42Z" }),
    ).toBe("42s");
    expect(
      checkDuration({ ...run, status: "pending", startedAt }, Date.parse(startedAt) + 3_723_000),
    ).toBe("1h 2m");
  });

  it("reruns failed checks and shows them queued", async () => {
    let rerun = false;
    const prDetail = vi.fn(async () => mockPrDetail(T, { rerun }));
    const prRerunChecks = vi.fn(async () => {
      rerun = true;
      return { runIds: ["9102"], skipped: [] };
    });
    renderWithApi(<PrPanel threadId={T} />, { prDetail, prRerunChecks });

    const checks = within(await screen.findByTestId("pr-panel")).getByRole("region", {
      name: "Checks",
    });
    fireEvent.click(within(checks).getByRole("button", { name: "Rerun failed" }));
    expect(await within(checks).findByText("Rerunning the failed jobs of 1 run.")).toBeTruthy();
    expect(prRerunChecks).toHaveBeenCalledWith(T);
    await waitFor(() => expect(within(checks).getByText("Queued")).toBeTruthy());
    expect(within(checks).queryByRole("button", { name: "Rerun failed" })).toBeNull();
  });

  it("flashes a check that turns failing on a refetch, and none that already were", async () => {
    let settled = false;
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => {
      const result = mockPrDetail(T);
      if (!settled || !result.detail) return result;
      const checkRuns = result.detail.checkRuns.map((run) =>
        run.name === "e2e"
          ? { ...run, status: "failing" as const, phase: "completed" as const }
          : run,
      );
      return { ...result, detail: { ...result.detail, checkRuns } };
    });
    renderWithApi(<PrPanel threadId={T} />, { prDetail, refreshGit: vi.fn(async () => {}) });

    const panel = await screen.findByTestId("pr-panel");
    const flashed = () =>
      within(panel)
        .getAllByTestId("check-run")
        .filter((row) => row.classList.contains("gram-flash"))
        .map((row) => row.textContent);
    expect(flashed()).toEqual([]);

    settled = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    await waitFor(() => expect(flashed()).toHaveLength(1));
    expect(flashed()[0]).toContain("e2e");
  });

  it("marks a failing or running check nobody requires as not required", async () => {
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => {
      const result = mockPrDetail(T);
      if (!result.detail) return result;
      const checkRuns = result.detail.checkRuns.map((run) =>
        run.name === "e2e"
          ? { ...run, status: "failing" as const, phase: "completed" as const, required: false }
          : run.name === "lint"
            ? { ...run, status: "pending" as const, phase: "running" as const, required: false }
            : { ...run, required: true },
      );
      return { ...result, detail: { ...result.detail, checkRuns } };
    });
    renderWithApi(<PrPanel threadId={T} />, { prDetail });
    const panel = await screen.findByTestId("pr-panel");
    await waitFor(() => expect(within(panel).getAllByTestId("check-not-required")).toHaveLength(2));
    const row = within(panel)
      .getAllByTestId("check-run")
      .find((each) => each.textContent.startsWith("e2e"))!;
    expect(row.textContent).toContain("not required");
  });

  it("doesn't flash a failure that arrived while the panel was hidden", async () => {
    let report: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let settled = false;
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => {
      const result = mockPrDetail(T);
      if (!settled || !result.detail) return result;
      const checkRuns = result.detail.checkRuns.map((run) =>
        run.name === "e2e" ? { ...run, status: "failing" as const } : run,
      );
      return { ...result, detail: { ...result.detail, checkRuns } };
    });
    renderWithApi(<PrPanel threadId={T} />, { prDetail, refreshGit: vi.fn(async () => {}) });
    const panel = await screen.findByTestId("pr-panel");
    const e2e = () =>
      within(panel)
        .getAllByTestId("check-run")
        .find((row) => row.textContent.startsWith("e2e"))!;

    act(() => report?.([{ isIntersecting: false }]));
    settled = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh pull request" }));
    await waitFor(() => expect(e2e().textContent).toContain("Failing"));
    act(() => report?.([{ isIntersecting: true }]));
    expect(e2e().classList.contains("gram-flash")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("names a rerun failure", async () => {
    const prRerunChecks = vi.fn(async () => {
      throw new Error("run 9102 is still in progress");
    });
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), prRerunChecks });

    fireEvent.click(await screen.findByRole("button", { name: "Rerun failed" }));
    expect((await screen.findByRole("alert")).textContent).toBe("run 9102 is still in progress");
  });

  it("opens a commit on the host only when its oid is clicked", async () => {
    const openExternal = vi.fn(async () => {});
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), openExternal });

    const commits = within(await screen.findByTestId("pr-panel")).getByRole("region", {
      name: "Commits",
    });
    fireEvent.click(within(commits).getByRole("button", { name: /Commits/ }));
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(within(commits).getByRole("button", { name: "Open commit 3f9c2d1 on GitHub" }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/example/api/commit/3f9c2d1a8b");
  });

  it("gives file rows the Diff panel's actions", async () => {
    const root = "/Users/dev/code/api/.worktrees/fix-flaky-retry";
    useThreadsStore.setState({ byId: { [T]: { thread: { checkout: { path: root } } } as never } });
    const openInEditor = vi.fn(async () => ({ editor: "VS Code" }));
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), openInEditor });

    const [file] = within(await screen.findByTestId("pr-panel")).getAllByTestId("diff-file");
    const path = "src/retry.test.ts";
    expect(within(file!).getByRole("button", { name: `Show ${path} in Files` })).toBeTruthy();
    expect(within(file!).getByRole("button", { name: revealLabel(path) })).toBeTruthy();
    fireEvent.click(within(file!).getByRole("button", { name: `Open ${path} in editor` }));
    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith(path, { threadId: T }));
  });

  it("switches to the Review tab and loads the bot review", async () => {
    const reviews = new MockReviews();
    const prReview = vi.fn(async () => reviews.review(T));
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), prReview });

    await screen.findByTestId("pr-panel");
    expect(prReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /^Review/ }));
    expect((await screen.findByTestId("review-verdict")).textContent).toContain(
      "Changes requested",
    );
    expect(screen.queryByTestId("pr-panel")).toBeNull();
  });

  it("opens on the Review tab when that was asked for before it mounted", async () => {
    useThreadsStore.setState({ byId: { [T]: pr("2026-09-16T10:00:00Z") } });
    useLayoutStore.setState({ prPanelTab: "review" });
    const reviews = new MockReviews();
    renderWithApi(<PrPanel threadId={T} />, {
      prDetail: vi.fn(async () => mockPrDetail(T)),
      prReview: vi.fn(async () => reviews.review(T)),
    });
    await screen.findByTestId("review-verdict");
    expect(screen.getByRole("tab", { name: /^Review/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("stays on the Review tab while a badge update refetches the PR", async () => {
    useThreadsStore.setState({ byId: { [T]: pr("2026-09-16T10:00:00Z") } });
    const reviews = new MockReviews();
    const prDetail = vi
      .fn(async (): Promise<PrDetailResult> => mockPrDetail(T))
      .mockImplementationOnce(async () => mockPrDetail(T))
      // The refetch after the badge moves never settles, as on a slow link.
      .mockImplementation(() => new Promise<PrDetailResult>(() => {}));
    renderWithApi(<PrPanel threadId={T} />, {
      prDetail,
      prReview: vi.fn(async () => reviews.review(T)),
    });

    await screen.findByTestId("pr-panel");
    fireEvent.click(screen.getByRole("tab", { name: /^Review/ }));
    await screen.findByTestId("review-verdict");

    act(() => useThreadsStore.setState({ byId: { [T]: pr("2026-09-16T10:05:00Z") } }));
    await waitFor(() => expect(prDetail).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Loading pull request…")).toBeNull();
    expect(screen.getByRole("tab", { name: /^Review/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("review-verdict")).toBeTruthy();
  });

  it("offers Push N commits once the branch with a PR is ahead of origin", async () => {
    useThreadsStore.setState({
      byId: {
        [T]: {
          thread: { checkout: { path: "/repo" } },
          git: {
            repo: true,
            branch: "fix/flaky-retry",
            origin: "example/api",
            upstream: "ahead",
            aheadUpstream: 2,
            pr: { number: 412, updatedAt: "2026-09-16T10:00:00Z", checks: "failing" },
          },
        } as never,
      },
    });
    const pushBranch = vi.fn(async () => ({ branch: "fix/flaky-retry", published: false }));
    renderWithApi(<PrPanel threadId={T} />, { ...withResult(mockPrDetail(T)), pushBranch });

    await screen.findByTestId("pr-panel");
    const push = within(screen.getByTestId("pr-panel-push")).getByRole("button", {
      name: "Push 2 commits",
    });
    fireEvent.click(push);
    await waitFor(() => expect(pushBranch).toHaveBeenCalledWith(T));
  });

  it("shows a friendly state when the server hasn't implemented git.prDetail", async () => {
    const prDetail = vi.fn(async (): Promise<PrDetailResult> => {
      throw new NotImplemented({ rpc: "git.prDetail" });
    });
    renderWithApi(<PrPanel threadId={T} />, { prDetail });
    expect(await screen.findByText("The PR panel isn't available yet.")).toBeTruthy();
  });
});

describe("commitUrl", () => {
  it("builds the commit page from any host's PR URL", () => {
    expect(commitUrl("https://github.com/example/api/pull/412", "abc")).toBe(
      "https://github.com/example/api/commit/abc",
    );
    expect(commitUrl("https://organization.example.invalid/org/repo/pull/7/", "abc")).toBe(
      "https://organization.example.invalid/org/repo/commit/abc",
    );
    expect(commitUrl("https://organization.example.invalid/not-a-pr", "abc")).toBeUndefined();
  });
});
