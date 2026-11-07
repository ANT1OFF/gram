// @vitest-environment happy-dom
import type { PrDetail, PrMergeOptions, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockPrDetail } from "@/api/mock-git";

import { mergeBlockedReason, PrActions } from "./pr-actions";
import { renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;

const detail = (writes: Parameters<typeof mockPrDetail>[1] = {}): PrDetail =>
  mockPrDetail(T, writes).detail!;

const options = (overrides: Partial<PrMergeOptions> = {}) =>
  vi.fn(async (): Promise<PrMergeOptions> => ({
    strategies: ["squash", "rebase"],
    autoMerge: true,
    babysit: false,
    ...overrides,
  }));

afterEach(cleanup);

describe("PrActions", () => {
  it("merges with a strategy the repository allows, naming the PR", async () => {
    const prMerge = vi.fn(async () => {});
    renderWithApi(<PrActions threadId={T} detail={detail()} />, {
      prMergeOptions: options(),
      prMerge,
    });

    fireEvent.click(screen.getByTestId("pr-merge"));
    const dialog = await screen.findByTestId("pr-merge-dialog");
    expect(within(dialog).getByText("Merge #412 into main?")).toBeTruthy();
    expect(
      (await within(dialog).findByRole<HTMLInputElement>("radio", { name: "Squash and merge" }))
        .checked,
    ).toBe(true);
    expect(within(dialog).queryByRole("radio", { name: "Create a merge commit" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Rebase and merge" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rebase and merge" }));
    await waitFor(() => expect(prMerge).toHaveBeenCalledWith(T, "rebase", false));
    expect((await screen.findByRole("status")).textContent).toBe("Merged #412.");
    expect(screen.queryByTestId("pr-merge-dialog")).toBeNull();
  });

  it("turns on auto-merge, but not in babysit mode", async () => {
    const prMerge = vi.fn(async () => {});
    renderWithApi(<PrActions threadId={T} detail={detail()} />, {
      prMergeOptions: options(),
      prMerge,
    });
    fireEvent.click(screen.getByTestId("pr-merge"));
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Merge automatically once checks and reviews pass",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable auto-merge" }));
    await waitFor(() => expect(prMerge).toHaveBeenCalledWith(T, "squash", true));
    cleanup();

    renderWithApi(<PrActions threadId={T} detail={detail()} />, {
      prMergeOptions: options({ babysit: true }),
      prMerge,
    });
    fireEvent.click(screen.getByTestId("pr-merge"));
    const box = await screen.findByRole<HTMLInputElement>("checkbox");
    expect(box.disabled).toBe(true);
    expect(screen.getByTestId("auto-merge-babysit")).toBeTruthy();
  });

  it("keeps the merge dialog open with the refusal", async () => {
    const prMerge = vi.fn(async () => {
      throw new Error("Pull request example/api#412 is not mergeable");
    });
    renderWithApi(<PrActions threadId={T} detail={detail()} />, {
      prMergeOptions: options(),
      prMerge,
    });
    fireEvent.click(screen.getByTestId("pr-merge"));
    const dialog = await screen.findByTestId("pr-merge-dialog");
    await within(dialog).findByRole("radio", { name: "Squash and merge" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Squash and merge" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Pull request example/api#412 is not mergeable",
    );
  });

  it("closes after confirming, and reopens a closed PR", async () => {
    const prClose = vi.fn(async () => {});
    renderWithApi(<PrActions threadId={T} detail={detail()} />, { prClose });
    fireEvent.click(screen.getByRole("button", { name: "More PR actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close pull request…" }));
    const dialog = await screen.findByTestId("pr-close-dialog");
    expect(within(dialog).getByText("Close #412 without merging?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close pull request" }));
    await waitFor(() => expect(prClose).toHaveBeenCalledWith(T));
    cleanup();

    const prReopen = vi.fn(async () => {});
    renderWithApi(<PrActions threadId={T} detail={detail({ state: "CLOSED" })} />, { prReopen });
    expect(screen.queryByRole("button", { name: "Merge…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(prReopen).toHaveBeenCalledWith(T));
  });

  it("marks a draft ready and converts a ready PR back", async () => {
    const prReady = vi.fn(async () => {});
    renderWithApi(<PrActions threadId={T} detail={detail({ isDraft: true })} />, { prReady });
    expect(screen.queryByRole("button", { name: "Merge…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ready for review" }));
    await waitFor(() => expect(prReady).toHaveBeenCalledWith(T, false));
    cleanup();

    renderWithApi(<PrActions threadId={T} detail={detail()} />, { prReady });
    fireEvent.click(screen.getByRole("button", { name: "More PR actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Convert to draft" }));
    await waitFor(() => expect(prReady).toHaveBeenCalledWith(T, true));
  });

  it("offers only the menu's link and binding once merged", async () => {
    const onBind = vi.fn();
    renderWithApi(
      <PrActions threadId={T} detail={detail({ state: "MERGED" })} onBind={onBind} />,
      {},
    );
    expect(screen.queryByTestId("pr-actions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More PR actions" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Bind another PR…", "Copy PR link"]);
    fireEvent.click(items[0]!);
    expect(onBind).toHaveBeenCalled();
  });
});

describe("mergeBlockedReason", () => {
  const failing = { name: "test", status: "failing", conclusion: "FAILURE", link: "" } as const;
  const passing = { name: "lint", status: "passing", conclusion: "SUCCESS", link: "" } as const;

  it("says what blocks the merge, worst first: failing checks, conflicts, changes requested", () => {
    expect(
      mergeBlockedReason(
        { reviewDecision: "CHANGES_REQUESTED", checkRuns: [failing, passing] },
        "blocked",
      ),
    ).toBe("Blocked: 1 failing check, changes requested");
    expect(
      mergeBlockedReason({ reviewDecision: "", checkRuns: [failing, failing] }, "conflicts"),
    ).toBe("Blocked: 2 failing checks, conflicts");
    expect(
      mergeBlockedReason({ reviewDecision: "CHANGES_REQUESTED", checkRuns: [] }, "conflicts"),
    ).toBe("Blocked: conflicts, changes requested");
  });

  it("names a missing review when GitHub blocks for nothing else the panel sees", () => {
    expect(
      mergeBlockedReason({ reviewDecision: "REVIEW_REQUIRED", checkRuns: [] }, "blocked"),
    ).toBe("Blocked: review required");
    expect(mergeBlockedReason({ reviewDecision: "", checkRuns: [passing] }, "blocked")).toBe(
      "Blocked: required reviews or checks are missing",
    );
  });

  it("leaves a mergeable PR, and a cancelled check, unblocked", () => {
    const cancelled = { ...failing, conclusion: "CANCELLED" } as const;
    expect(
      mergeBlockedReason({ reviewDecision: "APPROVED", checkRuns: [passing] }, "mergeable"),
    ).toBe(undefined);
    expect(mergeBlockedReason({ reviewDecision: "", checkRuns: [cancelled] }, undefined)).toBe(
      undefined,
    );
  });
});

describe("PrActions when blocked", () => {
  it("steps Merge back to a secondary button described by the reason, and still opens it", async () => {
    renderWithApi(<PrActions threadId={T} detail={detail()} merge="blocked" />, {
      prMergeOptions: options(),
    });
    // The button says the merge is blocked, and by how much, not only "Merge".
    const merge = screen.getByRole("button", { name: "Merge blocked · 2 reasons…" });
    expect(merge.dataset["blocked"]).toBe("true");
    const reason = screen.getByTestId("pr-merge-blocked");
    expect(reason.textContent).toBe("Merge blocked · 2 reasons: check, changes requested");
    expect(merge.getAttribute("aria-describedby")).toBe(reason.id);
    fireEvent.click(merge);
    await screen.findByTestId("pr-merge-dialog");
    // And so does the dialog it opens.
    expect(screen.getByTestId("pr-merge-dialog-blocked").textContent).toBe(
      "Merge blocked · 2 reasons: check, changes requested",
    );
  });

  it("names each blocker, then leads the action row with the worst one's next step", () => {
    const onBlocker = vi.fn();
    renderWithApi(
      <PrActions
        threadId={T}
        detail={detail()}
        merge="blocked"
        bot={{ kind: "blockers", label: "Review bot: 2 blocking findings", text: "2 blockers" }}
        onBlocker={onBlocker}
      />,
      { prMergeOptions: options() },
    );
    expect(screen.getByTestId("pr-merge-blocked").textContent).toBe(
      "Merge blocked · 3 reasons: check, changes requested, review bot",
    );
    const lines = within(screen.getByRole("list", { name: "What blocks the merge" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(lines).toEqual([
      "test (windows) failing",
      "Changes requested by reviewer",
      "Review bot: 2 blocking findings",
    ]);
    const row = within(screen.getByTestId("pr-actions")).getAllByRole("button");
    expect(row.map((button) => button.textContent)).toEqual([
      "Inspect test (windows) job",
      "Merge blocked · 3 reasons…",
    ]);
    fireEvent.click(row[0]!);
    expect(onBlocker).toHaveBeenCalledWith({
      kind: "inspectCheck",
      label: "Inspect test (windows) job",
      check: "test (windows)",
    });
  });

  it("asks the agent to fix conflicts when they are the worst blocker", async () => {
    const send = vi.fn(async () => ({ queued: false }) as never);
    const clean = { ...detail(), reviewDecision: "APPROVED", checkRuns: [] };
    renderWithApi(<PrActions threadId={T} detail={clean} merge="conflicts" />, {
      prMergeOptions: options(),
      send,
    });
    expect(screen.getByTestId("pr-merge-blocked").textContent).toBe(
      "Merge blocked · 1 reason: conflicts",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix conflicts" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(T, {
        text: expect.stringContaining("PR #412 has merge conflicts with main."),
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Sent to the agent");
  });

  it("offers no step it can't take: without onBlocker, a check's evidence isn't offered", () => {
    renderWithApi(<PrActions threadId={T} detail={detail()} merge="blocked" />, {
      prMergeOptions: options(),
    });
    expect(screen.queryByTestId("pr-next-action")).toBeNull();
    expect(screen.getByRole("button", { name: "Merge blocked · 2 reasons…" })).toBeTruthy();
  });

  it("keeps Merge primary for a PR nothing blocks", () => {
    const clear = { ...detail(), reviewDecision: "APPROVED", checkRuns: [] };
    renderWithApi(<PrActions threadId={T} detail={clear} merge="mergeable" />, {
      prMergeOptions: options(),
    });
    expect(screen.getByRole("button", { name: "Merge…" }).dataset["blocked"]).toBe("false");
    expect(screen.queryByTestId("pr-merge-blocked")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
    expect(screen.queryByTestId("pr-merge-dialog-blocked")).toBeNull();
  });
});
