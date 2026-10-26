// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockGitState } from "@/api/mock-git";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { PrActionItems, PrBadgeMenuItems } from "./pr-badge-menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "./ui/context-menu";

const copyText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/settings/copy-text", () => ({ copyText }));

const T = "t-flaky" as ThreadId;
const pr = mockGitState(T, undefined)!.pr!;

afterEach(cleanup);

const renderMenu = (api: Parameters<typeof renderWithApi>[1]) =>
  renderWithApi(
    <ContextMenu>
      <ContextMenuTrigger>badge</ContextMenuTrigger>
      <ContextMenuContent>
        <PrBadgeMenuItems threadId={T} pr={pr} />
      </ContextMenuContent>
    </ContextMenu>,
    api,
  );

const choose = async (name: string) => {
  fireEvent.contextMenu(screen.getByText("badge"));
  fireEvent.click(await screen.findByRole("menuitem", { name }));
};

const open = () => fireEvent.contextMenu(screen.getByText("row"));

const withPr = (overrides: Partial<typeof pr>) =>
  useThreadsStore.setState({
    byId: { [T]: { git: { ...mockGitState(T, undefined)!, pr: { ...pr, ...overrides } } } },
  } as never);

const renderActions = (api: Parameters<typeof renderWithApi>[1]) =>
  renderWithApi(
    <ContextMenu>
      <ContextMenuTrigger>row</ContextMenuTrigger>
      <ContextMenuContent>
        <PrActionItems threadId={T} />
      </ContextMenuContent>
    </ContextMenu>,
    api,
  );

describe("PrActionItems", () => {
  afterEach(() => useThreadsStore.setState({ byId: {} }));

  it("converts an open PR to a draft and points merging at the panel", async () => {
    withPr({});
    const prReady = vi.fn(async () => {});
    renderActions({ prReady });
    open();
    expect(
      await screen.findByRole("menuitem", { name: "Merge or close in PR panel" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy PR link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Convert to draft" }));
    await waitFor(() => expect(prReady).toHaveBeenCalledWith(T, true));
  });

  it("marks a draft ready, and reopens a closed PR", async () => {
    withPr({ isDraft: true });
    const prReady = vi.fn(async () => {});
    renderActions({ prReady });
    open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Ready for review" }));
    await waitFor(() => expect(prReady).toHaveBeenCalledWith(T, false));
    cleanup();

    withPr({ state: "CLOSED" });
    const prReopen = vi.fn(async () => {});
    renderActions({ prReopen });
    open();
    expect(await screen.findByRole("menuitem", { name: "Reopen #412" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Merge or close in PR panel" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reopen #412" }));
    await waitFor(() => expect(prReopen).toHaveBeenCalledWith(T));
  });

  it("offers nothing without a PR", async () => {
    renderActions({});
    open();
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  });
});

describe("PrBadgeMenuItems", () => {
  it("copies the PR link, opens it on GitHub, and refreshes it", async () => {
    const openExternal = vi.fn(async () => {});
    const refreshGit = vi.fn(async () => {});
    renderMenu({ openExternal, refreshGit });

    await choose("Copy PR link");
    expect(copyText).toHaveBeenCalledWith("https://github.com/example/api/pull/412");

    await choose("Open #412 on GitHub");
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://github.com/example/api/pull/412"),
    );

    await choose("Refresh from GitHub");
    expect(refreshGit).toHaveBeenCalledWith(T);
  });
});
