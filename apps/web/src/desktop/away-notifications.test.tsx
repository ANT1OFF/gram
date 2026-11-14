// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type ApprovalRequest,
  type DesktopNotification,
  type DesktopNotificationAction,
  type RequestId,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

import type { Api } from "@/api/types";
import { askOf } from "@/orchestration/ask-model";
import type { WorkspaceAsks } from "@/orchestration/ask-stack";
import { UNDO_MS, useAskStackStore } from "@/orchestration/ask-stack-store";
import { groupInbox } from "@/orchestration/inbox-model";
import { renderWithRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { AwayNotifications } from "./away-notifications";

// The real hook against a fake shell, with the asks it reads set by hand.

const asks = create<{ all: readonly WorkspaceAsks[] }>()(() => ({ all: [] }));
vi.mock("@/orchestration/ask-stack", () => ({
  useWorkspaceAsks: () => asks((s) => s.all),
}));

const approval = (id: string, command: string): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [],
});

/** A workspace whose one worker asks to run `command` as request `requestId`. */
const workspaceAsking = (
  workspace: string,
  thread: string,
  requestId: string,
  command: string,
): WorkspaceAsks => {
  const [group] = groupInbox([
    {
      threadId: thread as ThreadId,
      title: thread,
      feature: "f",
      request: approval(requestId, command),
    },
  ]);
  return {
    workspaceId: workspace as WorkspaceId,
    name: workspace,
    orchestratorThreadId: `${workspace}-orch` as ThreadId,
    asks: [askOf(group!)],
  };
};

let notes: DesktopNotification[];
let withdrawn: string[];
let onAction: ((action: DesktopNotificationAction) => void) | undefined;
let titles: Array<(title: string | null) => void>;
const respondMany = vi.fn(async (answers: Parameters<Api["respondMany"]>[0]) =>
  answers.map((a) => ({ threadId: a.threadId, requestId: a.requestId, ok: true as const })),
);
const api: Partial<Api> = {
  respondMany,
  // Each title waits until the test settles it, as a slow helper would.
  requestNoticeTitle: () => new Promise((resolve) => titles.push(resolve)),
};

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  notes = [];
  withdrawn = [];
  titles = [];
  onAction = undefined;
  respondMany.mockClear();
  asks.setState({ all: [] });
  useAskStackStore.setState({ held: [], sent: {}, problems: {}, replies: {} });
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  Object.defineProperty(window, "gram", {
    configurable: true,
    value: {
      notify: (n: DesktopNotification) => notes.push(n),
      withdrawNotification: (id: string) => withdrawn.push(id),
      onNotificationAction: (callback: (action: DesktopNotificationAction) => void) => {
        onAction = callback;
        return () => {
          onAction = undefined;
        };
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "gram");
});

/** `all` become the asks, and the title asked for the newest settles to the template's. */
const arrive = async (all: readonly WorkspaceAsks[], titleIndex: number) => {
  act(() => asks.setState({ all }));
  await flush();
  await act(async () => titles[titleIndex]!(null));
  await flush();
};

describe("asks' desktop notifications", () => {
  it("never shows a reused request id's command under the ask its title was asked for", async () => {
    renderWithRouter(<AwayNotifications graceMs={0} />, api);
    await flush();
    // Ask A in one workspace; its helper title is still being made.
    act(() => asks.setState({ all: [workspaceAsking("w-a", "t-a", "0", "npm test")] }));
    await flush();
    expect(titles).toHaveLength(1);
    // A is answered elsewhere, and a fresh agent process in another workspace asks B with the
    // same process-local request id.
    act(() => asks.setState({ all: [workspaceAsking("w-b", "t-b", "0", "rm -rf build")] }));
    await flush();
    // A's title arrives: A is gone, so it shows nothing.
    await act(async () => titles[0]!("Run the tests"));
    await flush();
    expect(notes.filter((n) => n.title === "Run the tests")).toEqual([]);
    expect(notes.some((n) => n.body === "npm test")).toBe(false);
    // B is its own ask, raised with its own title and command.
    await act(async () => titles[1]!(null));
    await flush();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: "Allow rm?",
      body: "rm -rf build",
      subtitle: expect.stringContaining("w-b"),
      actions: ["Allow once"],
    });
  });

  it("withdraws a notification whose request id now names another ask, and its Allow sends nothing", async () => {
    renderWithRouter(<AwayNotifications graceMs={0} />, api);
    await flush();
    act(() => asks.setState({ all: [workspaceAsking("w-a", "t-a", "0", "npm test")] }));
    await flush();
    await act(async () => titles[0]!(null));
    await flush();
    const [shown] = notes;
    expect(shown).toMatchObject({ body: "npm test", actions: ["Allow once"] });
    // The same key, another thread and command.
    act(() => asks.setState({ all: [workspaceAsking("w-a", "t-b", "0", "rm -rf build")] }));
    await flush();
    expect(withdrawn).toContain(shown!.id);
    // A press that was already on its way finds nothing to answer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => onAction?.({ id: shown!.id!, action: 0 }));
    await act(() => vi.advanceTimersByTimeAsync(UNDO_MS * 2));
    expect(respondMany).not.toHaveBeenCalled();
    expect(useAskStackStore.getState().held).toEqual([]);
  });

  it("answers the ask it showed through the stack's hold", async () => {
    renderWithRouter(<AwayNotifications graceMs={0} />, api);
    await flush();
    act(() => asks.setState({ all: [workspaceAsking("w-a", "t-a", "0", "npm test")] }));
    await flush();
    await act(async () => titles[0]!(null));
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => onAction?.({ id: notes[0]!.id!, action: 0 }));
    expect(useAskStackStore.getState().held.map((h) => h.done)).toEqual(["Allowed once"]);
    await act(() => vi.advanceTimersByTimeAsync(UNDO_MS));
    expect(respondMany).toHaveBeenCalledTimes(1);
    expect(respondMany.mock.calls[0]![0]).toEqual([
      {
        threadId: "t-a",
        requestId: "0",
        answer: { kind: "approval", decision: "allow", scope: "once" },
      },
    ]);
  });

  it("gathers a second ask with the first into one notification, which opens and answers nothing", async () => {
    renderWithRouter(<AwayNotifications graceMs={0} />, api);
    await flush();
    const a = workspaceAsking("w-a", "t-a", "1", "npm test");
    const b = workspaceAsking("w-b", "t-b", "2", "rm -rf build");
    const c = workspaceAsking("w-c", "t-c", "3", "git push");
    await arrive([a], 0);
    expect(notes).toHaveLength(1);
    const single = notes[0]!;
    expect(single).toMatchObject({ body: "npm test", actions: ["Allow once"] });

    await arrive([a, b], 1);
    // The first gives way: one notification lists both, with no Allow.
    expect(withdrawn).toContain(single.id);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatchObject({
      title: "2 asks are waiting for you",
      subtitle: "2 workspaces",
      body: "Allow npm test?\nAllow rm?",
    });
    expect(notes[1]!.actions).toBeUndefined();

    await arrive([a, b, c], 2);
    expect(notes).toHaveLength(3);
    expect(notes[2]).toMatchObject({ id: notes[1]!.id, title: "3 asks are waiting for you" });

    // One answered elsewhere: it stays up, unraised, until the last is gone.
    const before = withdrawn.length;
    act(() => asks.setState({ all: [b, c] }));
    await flush();
    expect(notes).toHaveLength(3);
    expect(withdrawn).toHaveLength(before);
    act(() => asks.setState({ all: [] }));
    await flush();
    expect(withdrawn.at(-1)).toBe(notes[1]!.id);
    expect(respondMany).not.toHaveBeenCalled();
  });

  it("raises one each with gathering turned off", async () => {
    useServerSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        notifications: { ...DEFAULT_SETTINGS.notifications, gatherAsks: false },
      },
    });
    renderWithRouter(<AwayNotifications graceMs={0} />, api);
    await flush();
    const a = workspaceAsking("w-a", "t-a", "1", "npm test");
    const b = workspaceAsking("w-b", "t-b", "2", "rm -rf build");
    await arrive([a], 0);
    await arrive([a, b], 1);
    expect(notes.map((n) => n.body)).toEqual(["npm test", "rm -rf build"]);
    expect(withdrawn).toEqual([]);
  });
});
