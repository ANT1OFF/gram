// @vitest-environment happy-dom
import type { BoundPr, GitState, ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockGitState } from "@/api/mock-git";
import { useThreadsStore } from "@/stores/threads";

import { renderWithApi } from "../test-utils";
import { PrBinding } from "./pr-binding";

const T = "t-flaky" as ThreadId;

const setThread = (boundPr: BoundPr | undefined, git: Partial<GitState> | undefined) =>
  act(() => {
    useThreadsStore.setState({ byId: { [T]: { thread: { id: T, boundPr }, git } as never } });
  });

const typeRef = (value: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Pull request number or URL" }), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Bind" }));
};

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

describe("PrBinding", () => {
  it("binds a bare number against the thread's origin", async () => {
    setThread(undefined, { origin: "example/api" });
    const prBind = vi.fn(async () => ({}) as never);
    renderWithApi(<PrBinding threadId={T} />, { prBind });

    expect(screen.queryByRole("switch", { name: "Watch CI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Bind a PR…" }));
    typeRef("#12");
    await waitFor(() => expect(prBind).toHaveBeenCalledWith(T, "example/api", 12));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("asks for the full URL without an origin, then binds by URL", async () => {
    setThread(undefined, undefined);
    const prBind = vi.fn(async () => ({}) as never);
    renderWithApi(<PrBinding threadId={T} />, { prBind });

    fireEvent.click(screen.getByRole("button", { name: "Bind a PR…" }));
    typeRef("12");
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the full PR URL");
    expect(prBind).not.toHaveBeenCalled();

    typeRef("https://github.com/owner/repo/pull/7/files");
    await waitFor(() => expect(prBind).toHaveBeenCalledWith(T, "owner/repo", 7));
  });

  it("cancels the form", () => {
    setThread(undefined, undefined);
    renderWithApi(<PrBinding threadId={T} />, {});
    fireEvent.click(screen.getByRole("button", { name: "Bind a PR…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Bind a PR…" })).toBeTruthy();
  });

  it("hands focus back to Bind a PR… when Escape closes the form", async () => {
    setThread(undefined, undefined);
    renderWithApi(<PrBinding threadId={T} />, {});
    const open = screen.getByRole("button", { name: "Bind a PR…" });
    open.focus();
    fireEvent.click(open);
    const field = screen.getByRole("textbox", { name: "Pull request number or URL" });
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bind a PR…" })),
    );
  });

  it("follows a bound PR, watches its CI and unbinds it", async () => {
    setThread({ repo: "example/api", number: 412, monitor: false }, mockGitState(T, undefined));
    const prSetMonitor = vi.fn(async () => undefined);
    const prUnbind = vi.fn(async () => undefined);
    renderWithApi(<PrBinding threadId={T} />, { prSetMonitor, prUnbind });

    expect(screen.getByTestId("pr-binding-status").textContent).toBe("Following example/api#412");
    const watch = screen.getByRole("switch", { name: "Watch CI" });
    expect(watch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(watch);
    await waitFor(() => expect(prSetMonitor).toHaveBeenCalledWith(T, true));

    setThread({ repo: "example/api", number: 412, monitor: true }, mockGitState(T, undefined));
    expect(watch.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(watch.hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Unbind" }));
    await waitFor(() => expect(prUnbind).toHaveBeenCalledWith(T));
  });

  it("opens the bound PR by its badge's URL, and only when the badge is that PR", async () => {
    setThread({ repo: "example/api", number: 412, monitor: false }, mockGitState(T, undefined));
    const openExternal = vi.fn(async () => undefined);
    renderWithApi(<PrBinding threadId={T} />, { openExternal });

    fireEvent.click(screen.getByRole("button", { name: "example/api#412" }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://github.com/example/api/pull/412"),
    );

    setThread({ repo: "example/other", number: 412, monitor: false }, mockGitState(T, undefined));
    expect(screen.queryByRole("button", { name: "example/other#412" })).toBeNull();
    expect(screen.getByTestId("pr-binding-status").textContent).toBe("Following example/other#412");
  });

  it("watching CI while unbound binds the branch's PR with monitoring", async () => {
    const git = mockGitState(T, undefined)!;
    const { origin: _origin, ...withoutOrigin } = git;
    setThread(undefined, withoutOrigin);
    const prBind = vi.fn(async () => ({}) as never);
    renderWithApi(<PrBinding threadId={T} />, { prBind });

    fireEvent.click(screen.getByRole("switch", { name: "Watch CI" }));
    await waitFor(() => expect(prBind).toHaveBeenCalledWith(T, "example/api", 412, true));
  });

  it("shows the api's error", async () => {
    setThread(undefined, { origin: "example/api" });
    const prBind = vi.fn(async () => {
      throw new Error("Could not resolve to a PullRequest");
    });
    renderWithApi(<PrBinding threadId={T} />, { prBind });
    fireEvent.click(screen.getByRole("button", { name: "Bind a PR…" }));
    typeRef("99");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not resolve to a PullRequest",
    );
  });
});
