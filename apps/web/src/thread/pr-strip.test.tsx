// @vitest-environment happy-dom
import { hiddenEntryOf, type BoundPr, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockExtraBadge } from "@/api/mock-extra-prs";
import { mockGitState, mockPrDetail } from "@/api/mock-git";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { PrStrip } from "./pr-strip";
import { usePrStripFold } from "./pr-strip-fold";

const T = "t-flaky" as ThreadId;

const mockPrChecks = async () => ({ checks: mockPrDetail(T).detail?.checkRuns ?? [] });

const setThread = (boundPr: BoundPr | undefined, withGit = true) =>
  act(() => {
    useThreadsStore.setState({
      byId: {
        [T]: {
          thread: { id: T, checkout: { path: "/repo" }, boundPr },
          git: withGit ? mockGitState(T, undefined) : undefined,
        } as never,
      },
    });
  });

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  usePrStripFold.setState({ expanded: [] });
});

const FOLLOWED = [
  { repo: "example/web", number: 9, monitor: false },
  { repo: "example/infra", number: 10, monitor: false },
];

/** #412 hidden as it stands in the mock, checks failing and all. */
const hidden412 = () =>
  hiddenEntryOf({ repo: "example/api", number: 412 }, mockGitState(T, undefined)!.pr);

const setStrip = (fields: { boundPr?: BoundPr; extraPrs?: BoundPr[]; hiddenPrs?: unknown[] }) =>
  act(() => {
    useThreadsStore.setState({
      byId: {
        [T]: {
          thread: { id: T, checkout: { path: "/repo" }, ...fields },
          git: mockGitState(T, undefined),
        } as never,
      },
    });
  });

describe("PrStrip", () => {
  it("renders nothing for a thread without a PR", () => {
    setThread(undefined, false);
    const prChecks = vi.fn(async () => ({ checks: [] }));
    renderWithApi(<PrStrip threadId={T} focused />, { prChecks });
    expect(screen.queryByTestId("pr-strip")).toBeNull();
    expect(prChecks).not.toHaveBeenCalled();
  });

  it("draws the whole row from the badge, and asks for the checks but never the PR detail", async () => {
    setThread(undefined);
    const prDetail = vi.fn(async () => mockPrDetail(T));
    const prChecks = vi.fn(mockPrChecks);
    renderWithApi(<PrStrip threadId={T} focused />, { prDetail, prChecks });
    expect(screen.getByTestId("pr-row").textContent).toContain("#412");
    expect(screen.getByTestId("pr-row-diff").textContent).toBe("+2−1");
    expect(screen.queryByRole("button", { name: "Unbind #412" })).toBeNull();

    fireEvent.click(screen.getByTestId("pr-row-ci"));
    await waitFor(() =>
      expect(screen.getAllByTestId("pr-ci-bucket").map((bucket) => bucket.textContent)).toEqual([
        "Failed1",
        "Running1",
        "Passed2",
      ]),
    );
    expect(prChecks).toHaveBeenCalledTimes(1);
    expect(prDetail).not.toHaveBeenCalled();
  });

  it("leaves the checks to the focused pane", () => {
    setThread(undefined);
    const prChecks = vi.fn(mockPrChecks);
    renderWithApi(<PrStrip threadId={T} focused={false} />, { prChecks });
    expect(screen.getByTestId("pr-row").textContent).toContain("#412");
    expect(prChecks).not.toHaveBeenCalled();
  });

  it("fetches the checks again when the thread binds another PR, without showing the last PR's", async () => {
    setThread({ repo: "example/api", number: 412, monitor: false });
    const pending = Promise.withResolvers<void>();
    const prChecks = vi
      .fn(mockPrChecks)
      .mockImplementationOnce(mockPrChecks)
      .mockImplementationOnce(async () => {
        await pending.promise;
        return { checks: [] };
      });
    renderWithApi(<PrStrip threadId={T} focused />, { prChecks });
    fireEvent.click(screen.getByTestId("pr-row-ci"));
    await screen.findAllByTestId("pr-ci-bucket");

    setThread({ repo: "example/infra", number: 88, monitor: false });
    await waitFor(() => expect(prChecks).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("pr-row").textContent).toContain("#88");
    // #412's checks must not be counted as #88's while #88's are still on their way.
    expect(screen.queryAllByTestId("pr-ci-bucket")).toEqual([]);
    pending.resolve();
    await waitFor(() => expect(screen.getByText("No checks reported.")).toBeTruthy());
  });

  it("shows a bound PR that merged as merged, though the server leaves its badge unanchored", () => {
    const git = mockGitState(T, undefined)!;
    act(() => {
      useThreadsStore.setState({
        byId: {
          [T]: {
            thread: {
              id: T,
              checkout: { path: "/repo" },
              boundPr: { repo: "example/api", number: 412, monitor: false },
            },
            git: { ...git, pr: { ...git.pr!, state: "MERGED", headMatches: false } },
          } as never,
        },
      });
    });
    renderWithApi(<PrStrip threadId={T} focused={false} />, {});
    expect(screen.getByRole("img", { name: "Merged" })).toBeTruthy();
  });

  it("offers the folder and terminal for the checkout's own repository and branch", async () => {
    setThread(undefined);
    renderWithApi(<PrStrip threadId={T} focused={false} />, {});
    fireEvent.click(screen.getByTestId("pr-row-repo"));
    const repoMenu = await screen.findByTestId("pr-row-repo-menu");
    expect(repoMenu.textContent).toContain("Open repository on GitHub");
    expect(repoMenu.textContent).toContain("Copy path");
    expect(repoMenu.textContent).toContain("Open in terminal");
  });

  it("offers a PR bound from another repository only what doesn't need its folder", async () => {
    const git = mockGitState(T, undefined)!;
    act(() => {
      useThreadsStore.setState({
        byId: {
          [T]: {
            thread: {
              id: T,
              checkout: { path: "/repo" },
              boundPr: { repo: "example/infra", number: 88, monitor: false },
            },
            git: {
              ...git,
              pr: { ...git.pr!, number: 88, url: "https://github.com/example/infra/pull/88" },
            },
          } as never,
        },
      });
    });
    const openExternal = vi.fn(async () => undefined);
    renderWithApi(<PrStrip threadId={T} focused={false} />, { openExternal });
    fireEvent.click(screen.getByTestId("pr-row-repo"));
    const repoMenu = await screen.findByTestId("pr-row-repo-menu");
    expect(repoMenu.textContent).toContain("Copy repository name");
    expect(repoMenu.textContent).not.toContain("Copy path");
    expect(repoMenu.textContent).not.toContain("Open in terminal");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open repository on GitHub" }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://github.com/example/infra"),
    );
  });

  it("says where the review bot stands, and only on a PR a bot has touched", () => {
    setThread(undefined);
    renderWithApi(<PrStrip threadId={T} focused={false} />, {});
    expect(screen.queryByTestId("pr-row-review")).toBeNull();

    act(() => {
      useThreadsStore.setState({
        byId: {
          [T]: {
            thread: { id: T, checkout: { path: "/repo" } },
            git: mockGitState(T, {
              bots: ["example-code-review[bot]"],
              verdictOnHead: "approved",
              reviewedHead: true,
              roundInFlight: false,
              threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
            }),
          } as never,
        },
      });
    });
    const chip = screen.getByRole("button", { name: "Review bot: approved" });
    expect(chip.textContent).toBe("approved");
    fireEvent.click(chip);
    expect(useLayoutStore.getState()).toMatchObject({ panelTab: "pr", prPanelTab: "review" });
  });

  it("unbinds a bound PR from its CI menu, not from the ×", async () => {
    setThread({ repo: "example/api", number: 412, monitor: false });
    const prUnbind = vi.fn(async () => undefined);
    renderWithApi(<PrStrip threadId={T} focused />, { prChecks: mockPrChecks, prUnbind });
    expect(screen.queryByRole("button", { name: "Unbind #412" })).toBeNull();
    fireEvent.click(screen.getByTestId("pr-row-ci"));
    fireEvent.click(await screen.findByRole("button", { name: "Unbind #412" }));
    await waitFor(() => expect(prUnbind).toHaveBeenCalledWith(T));
  });

  it("hides the branch's own PR with the ×, recording what already needed the user", async () => {
    setThread(undefined);
    const prHide = vi.fn(async () => undefined);
    const prUnbind = vi.fn(async () => undefined);
    renderWithApi(<PrStrip threadId={T} focused={false} />, { prHide, prUnbind });
    fireEvent.click(screen.getByRole("button", { name: "Hide #412 from this thread's PR list" }));
    await waitFor(() =>
      expect(prHide).toHaveBeenCalledWith(T, {
        repo: "example/api",
        number: 412,
        state: "OPEN",
        seen: [expect.stringMatching(/^ci:/), expect.stringMatching(/^changes:/)],
      }),
    );
    expect(prUnbind).not.toHaveBeenCalled();
  });

  it("starts folded, and remembers unfolding per thread", () => {
    setStrip({ extraPrs: FOLLOWED });
    renderWithApi(<PrStrip threadId={T} focused={false} />, {});
    expect(screen.getByTestId("pr-row").textContent).toContain("#412");
    expect(screen.queryAllByTestId("pr-row-extra")).toHaveLength(0);
    const fold = screen.getByRole("button", { name: "Show 2 more" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(screen.getAllByTestId("pr-row-extra")).toHaveLength(2);
    expect(usePrStripFold.getState().expanded).toEqual([T]);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryAllByTestId("pr-row-extra")).toHaveLength(0);
  });

  it("lets a followed PR lead when the thread's own is hidden, and offers the rest back", async () => {
    setStrip({ extraPrs: FOLLOWED, hiddenPrs: [hidden412()] });
    const prShowHidden = vi.fn(async () => undefined);
    const prUnbindExtra = vi.fn(async () => undefined);
    renderWithApi(<PrStrip threadId={T} focused={false} />, { prShowHidden, prUnbindExtra });
    expect(screen.queryByTestId("pr-row")).toBeNull();
    expect(screen.getAllByTestId("pr-row-extra")).toHaveLength(1);
    expect(screen.getByTestId("pr-row-extra").textContent).toContain("#9");
    expect(screen.getByRole("button", { name: "Show 1 more" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("pr-row-ci"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop following #9" }));
    await waitFor(() => expect(prUnbindExtra).toHaveBeenCalledWith(T, "example/web", 9));

    fireEvent.click(screen.getByRole("button", { name: "Show 1 hidden PR" }));
    await waitFor(() => expect(prShowHidden).toHaveBeenCalledWith(T));
  });

  it("brings a hidden PR back once something new needs the user, even folded", () => {
    // Hidden while nothing was wrong; its checks have failed since.
    const git = mockGitState(T, undefined)!;
    const nine = {
      ...mockExtraBadge({ repo: "example/web", number: 9 }),
      checks: "failing" as const,
    };
    act(() => {
      useThreadsStore.setState({
        byId: {
          [T]: {
            thread: {
              id: T,
              checkout: { path: "/repo" },
              extraPrs: FOLLOWED,
              hiddenPrs: [{ repo: "example/web", number: 9, state: "OPEN" }],
            },
            git: { ...git, extraPrs: [nine] },
          } as never,
        },
      });
    });
    renderWithApi(<PrStrip threadId={T} focused={false} />, {});
    expect(screen.getByTestId("pr-row").textContent).toContain("#412");
    expect(screen.queryByTestId("pr-strip-hidden")).toBeNull();
    const extras = screen.getAllByTestId("pr-row-extra");
    expect(extras.map((row) => row.textContent?.includes("#9"))).toEqual([true]);
    expect(screen.getByRole("button", { name: "Show 1 more" })).toBeTruthy();
  });

  it("is only the hidden count when every row is hidden and none needs the user", () => {
    const git = mockGitState(T, undefined)!;
    act(() => {
      useThreadsStore.setState({
        byId: {
          [T]: {
            thread: {
              id: T,
              checkout: { path: "/repo" },
              hiddenPrs: [{ repo: "example/api", number: 412, state: "MERGED" }],
            },
            git: { ...git, pr: { ...git.pr!, state: "MERGED" } },
          } as never,
        },
      });
    });
    renderWithApi(<PrStrip threadId={T} focused={false} />, {});
    expect(screen.queryByTestId("pr-row")).toBeNull();
    expect(screen.queryByTestId("pr-strip-fold")).toBeNull();
    expect(screen.getByRole("button", { name: "Show 1 hidden PR" }).textContent).toBe("1 hidden");
  });
});
