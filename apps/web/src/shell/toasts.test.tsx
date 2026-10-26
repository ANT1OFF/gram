// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installKeyboard, registerShortcut } from "@/keyboard/registry";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { showUndo, useUndoToasts } from "@/stores/undo-toasts";

import { useToastDock } from "./toast-dock";
import { Toasts } from "./toasts";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const notify = (title: string) =>
  act(() =>
    useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title, body: "" }),
  );

/** A stand-in right panel: content with a button at its foot, then the dock. */
function Panel() {
  const setNode = useToastDock((s) => s.setNode);
  return (
    <aside data-testid="panel">
      <button type="button">Apply suggestion</button>
      <div ref={setNode} data-testid="toast-dock" />
    </aside>
  );
}

beforeEach(() => {
  useThreadsStore.setState({ notifications: [] });
});

afterEach(() => {
  cleanup();
  useToastDock.setState({ node: null });
  useLayoutStore.setState({ panelOpen: true, focusMode: false });
});

describe("Toasts", () => {
  it("shows a change with Undo, which runs once and closes the toast", async () => {
    render(<Toasts />);
    const undo = vi.fn(async () => {});
    act(() => showUndo({ key: "w", title: "Paused platform", undo }));
    // A later change to the same thing replaces the toast rather than stacking another.
    act(() => showUndo({ key: "w", title: "Renamed to platform-2", undo }));
    const toasts = screen.getAllByTestId("undo-toast");
    expect(toasts.map((toast) => toast.textContent)).toEqual(["Renamed to platform-2Undo"]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useUndoToasts.getState().toasts).toEqual([]));
  });

  it("docks below the open right panel's content instead of floating over it", () => {
    useLayoutStore.setState({
      panelOpen: true,
      focusMode: false,
      threadInView: true,
      windowWidth: 1440,
    });
    render(
      <>
        <Panel />
        <Toasts />
      </>,
    );
    notify("Published feat/x");

    const toast = screen.getByTestId("toast");
    expect(screen.getByTestId("toast-dock").contains(toast)).toBe(true);
    const list = screen.getByRole("list", { name: "Notifications" });
    expect(list.getAttribute("data-docked")).toBe("true");
    expect(list.className).not.toContain("fixed");
    expect(list.getAttribute("aria-live")).toBe("polite");
    // The panel's own button comes before the toasts in the document and isn't covered by them.
    const apply = screen.getByRole("button", { name: "Apply suggestion" });
    expect(apply.compareDocumentPosition(toast) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("floats bottom-right while the panel is closed or in focus mode", () => {
    useLayoutStore.setState({ panelOpen: false, focusMode: false });
    render(
      <>
        <Panel />
        <Toasts />
      </>,
    );
    notify("CI passed on #7");

    const list = screen.getByRole("list", { name: "Notifications" });
    expect(list.getAttribute("data-docked")).toBe("false");
    expect(list.className).toContain("fixed");
    expect(screen.getByTestId("toast-dock").childElementCount).toBe(0);

    act(() => useLayoutStore.setState({ panelOpen: true, focusMode: true }));
    expect(screen.getByRole("list", { name: "Notifications" }).getAttribute("data-docked")).toBe(
      "false",
    );
  });

  it("dismisses a toast on Escape", () => {
    render(<Toasts />);
    notify("Couldn't push");
    const toast = screen.getByTestId("toast");
    fireEvent.keyDown(toast.querySelector("button")!, { key: "Escape" });
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("moves focus to the toast that takes a dismissed toast's place", async () => {
    render(<Toasts />);
    notify("First");
    notify("Second");
    const [first] = screen.getAllByRole("button", { name: "Dismiss" });
    first!.focus();
    fireEvent.keyDown(first!, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByTestId("toast")).toHaveLength(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss" })),
    );
  });

  it("keeps Escape on a toast from running an app shortcut too, such as denying an approval", () => {
    const deny = vi.fn();
    const uninstall = installKeyboard(window);
    const unregister = registerShortcut({
      id: "approval.deny",
      keys: "escape",
      label: "Deny",
      group: "Thread",
      run: deny,
    });
    try {
      render(<Toasts />);
      notify("Couldn't push");
      fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss" }), { key: "Escape" });
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(deny).not.toHaveBeenCalled();
    } finally {
      unregister();
      uninstall();
    }
  });

  it("shows at most three toasts", () => {
    render(<Toasts />);
    for (const title of ["one", "two", "three", "four"]) notify(title);
    expect(screen.getAllByTestId("toast").map((t) => t.textContent)).toEqual([
      "Notice: two",
      "Notice: three",
      "Notice: four",
    ]);
  });
});
