// @vitest-environment happy-dom
import type { PrDetail, PrMergeOptions, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockPrDetail } from "@/api/mock-git";

import { PrActions } from "./pr-actions";
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

    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
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
