// @vitest-environment happy-dom
import type { ThreadId, ThreadSummary, ProjectId } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installKeyboard, registerShortcut } from "@/keyboard/registry";
import { notificationTime } from "@/lib/time";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useNotificationHistory } from "@/stores/notifications";
import { useThreadsStore } from "@/stores/threads";
import { Toasts } from "@/shell/toasts";

import { NotificationsBell, NotificationsPanel } from "./notifications-panel";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
beforeEach(() => {
  useNotificationHistory.setState({ entries: [], quiet: {} });
  useThreadsStore.setState({ notifications: [], byId: {}, ready: true });
  useLayoutStore.setState({
    panelOpen: false,
    panelPeek: false,
    threadInView: false,
    focusMode: false,
    windowWidth: 1440,
  });
  navigate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Notifications center", () => {
  it("opens explicitly from a closed panel without a thread and formats 24-hour timestamps", () => {
    render(<NotificationsBell />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(useLayoutStore.getState().panelTab).toBe("notifications");
    expect(fitShell(useLayoutStore.getState()).panel).toBe("side");
    expect(notificationTime(new Date(2026, 9, 10, 23, 15).getTime())).toContain("23:15");
  });

  it("reads and clears plain text history with truthful unavailable thread targets", () => {
    render(
      <>
        <NotificationsBell />
        <NotificationsPanel />
        <Toasts />
      </>,
    );
    act(() =>
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "error",
        title: "<script>invented</script>",
        body: "javascript:alert(1)",
        threadId: "deleted" as never,
      }),
    );
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
    expect(screen.getByTestId("notification-entry").querySelector("script")).toBeNull();
    expect(screen.getByText("Thread no longer available")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByTestId("notification-entry")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(screen.queryByTestId("notification-entry")).toBeNull();
    expect(screen.getByText("No notifications yet")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens a known thread, marks its notice read, and withdraws navigation after removal", () => {
    const id = "existing" as ThreadId;
    const summary: ThreadSummary = {
      status: "idle",
      pendingRequests: [],
      queue: [],
      thread: {
        id,
        projectId: "synthetic-project" as ProjectId,
        title: "Synthetic thread",
        userNamed: false,
        model: { agent: "codex", model: "synthetic-model" },
        mode: "default",
        checkout: { kind: "main", path: "/synthetic/repo" },
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: 1,
        lastActivityAt: 1,
      },
    };
    useThreadsStore.getState().applyEvent({ type: "threads.snapshot", threads: [summary] });
    useThreadsStore
      .getState()
      .applyEvent({ type: "notify", kind: "done", title: "Synthetic turn finished", threadId: id });
    render(<NotificationsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Synthetic thread" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: id } });
    expect(useNotificationHistory.getState().entries[0]?.read).toBe(true);
    act(() => useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: id }));
    expect(screen.queryByRole("button", { name: "Synthetic thread" })).toBeNull();
    expect(screen.getByText("Thread no longer available")).toBeTruthy();
  });

  it("retains history after toast expiry and returns Escape focus without denying an approval", async () => {
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
      render(
        <>
          <NotificationsBell />
          <NotificationsPanel />
          <Toasts />
        </>,
      );
      vi.useFakeTimers();
      act(() =>
        useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title: "A notice" }),
      );
      act(() => vi.advanceTimersByTime(6001));
      vi.useRealTimers();
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(screen.getByTestId("notification-entry")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Notifications, 1 unread" }));
      const read = screen.getByRole("button", { name: "Mark all read" });
      read.focus();
      fireEvent.keyDown(read, { key: "Escape" });
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("notifications-bell")),
      );
      expect(fitShell(useLayoutStore.getState()).panel).toBe("none");
      expect(deny).not.toHaveBeenCalled();
    } finally {
      unregister();
      uninstall();
    }
  });
});
