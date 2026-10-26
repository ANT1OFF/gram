// @vitest-environment happy-dom
import type {
  ApprovalRequest,
  RequestId,
  ThreadId,
  TrayAction,
  TrayMenu,
  WorkspaceId,
  WorkspaceState,
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

import { MenuBar } from "./menu-bar";

// The real component against a fake shell, with the asks it reads set by hand.

const asks = create<{ all: readonly WorkspaceAsks[] }>()(() => ({ all: [] }));
vi.mock("@/orchestration/ask-stack", () => ({
  useWorkspaceAsks: () => asks((s) => s.all),
  useOpenThread: () => () => {},
}));
const states = create<{ all: readonly WorkspaceState[] }>()(() => ({ all: [] }));
vi.mock("@/orchestration/use-orchestration", () => ({
  useWorkspaces: () => states((s) => s.all),
}));
const NO_STRIP: never[] = [];
vi.mock("@/views/quiet-view", () => ({ useQuietStrip: () => NO_STRIP }));

const approval = (id: string, command: string): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [],
});

/** A workspace whose one worker asks to run `command` as request `requestId`. */
const workspaceAsking = (thread: string, requestId: string, command: string): WorkspaceAsks => {
  const [group] = groupInbox([
    {
      threadId: thread as ThreadId,
      title: thread,
      feature: "f",
      request: approval(requestId, command),
    },
  ]);
  return {
    workspaceId: "w-a" as WorkspaceId,
    name: "w-a",
    orchestratorThreadId: "w-a-orch" as ThreadId,
    asks: [askOf(group!)],
  };
};

const stateOf = (id: string, paused = false): WorkspaceState =>
  ({
    workspace: { id: id as WorkspaceId, name: id },
    ...(paused ? { paused: { reason: "user", at: 0 } } : {}),
  }) as unknown as WorkspaceState;

let menus: TrayMenu[];
let onAction: ((action: TrayAction) => void) | undefined;
const respondMany = vi.fn(async (answers: Parameters<Api["respondMany"]>[0]) =>
  answers.map((a) => ({ threadId: a.threadId, requestId: a.requestId, ok: true as const })),
);
const setOrchestratorPaused = vi.fn(async (workspaceId: WorkspaceId, paused: boolean) => {
  const all = states
    .getState()
    .all.map((w) =>
      w.workspace.id !== workspaceId
        ? w
        : paused
          ? { ...w, paused: { reason: "user" as const, at: 0 } }
          : { workspace: w.workspace, charter: w.charter },
    );
  states.setState({ all });
  return all.find((w) => w.workspace.id === workspaceId)!;
});
const api: Partial<Api> = { respondMany, setOrchestratorPaused };

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const allowOf = (menu: TrayMenu | undefined, command: string) =>
  menu?.asks.find((ask) => ask.lines[0] === command && ask.answer !== undefined);

beforeEach(() => {
  menus = [];
  onAction = undefined;
  respondMany.mockClear();
  setOrchestratorPaused.mockClear();
  asks.setState({ all: [] });
  states.setState({ all: [] });
  useAskStackStore.setState({ held: [], sent: {}, problems: {}, replies: {}, focusKey: undefined });
  Object.defineProperty(window, "gram", {
    configurable: true,
    value: {
      keepInTray: { get: async () => true, set: async () => {}, onChange: () => () => {} },
      tray: {
        show: (menu: TrayMenu) => menus.push(menu),
        onAction: (callback: (action: TrayAction) => void) => {
          onAction = callback;
          return () => {
            onAction = undefined;
          };
        },
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

describe("the menu bar's asks", () => {
  it("never answers a request changed under the same id with the Allow shown for the old one", async () => {
    renderWithRouter(<MenuBar />, api);
    await flush();
    act(() => asks.setState({ all: [workspaceAsking("t-a", "0", "npm test")] }));
    await flush();
    const old = allowOf(menus.at(-1), "npm test");
    expect(old).toMatchObject({ answer: "Allow" });
    // The same workspace, thread and request id now asks something else.
    act(() => asks.setState({ all: [workspaceAsking("t-a", "0", "rm -rf build")] }));
    await flush();
    const now = allowOf(menus.at(-1), "rm -rf build");
    expect(now?.id).not.toBe(old!.id);
    // The Allow for `npm test`, delivered after the change, sends nothing.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => onAction?.({ kind: "answer", id: old!.id }));
    await act(() => vi.advanceTimersByTimeAsync(UNDO_MS * 2));
    expect(useAskStackStore.getState().held).toEqual([]);
    expect(respondMany).not.toHaveBeenCalled();
  });

  it("answers the ask it showed through the stack's hold", async () => {
    renderWithRouter(<MenuBar />, api);
    await flush();
    act(() => asks.setState({ all: [workspaceAsking("t-a", "0", "npm test")] }));
    await flush();
    const shown = allowOf(menus.at(-1), "npm test")!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => onAction?.({ kind: "answer", id: shown.id }));
    expect(useAskStackStore.getState().held).toMatchObject([{ done: "Allowed" }]);
    await act(() => vi.advanceTimersByTimeAsync(UNDO_MS * 2));
    expect(respondMany).toHaveBeenCalledTimes(1);
    expect(respondMany.mock.calls[0]![0]).toMatchObject([
      { threadId: "t-a", requestId: "0", answer: { kind: "approval", decision: "allow" } },
    ]);
  });

  it("pauses every workspace from Pause all, then offers Resume all, as Quiet's menu does", async () => {
    states.setState({ all: [stateOf("w-a"), stateOf("w-b", true)] });
    asks.setState({ all: [workspaceAsking("t-a", "0", "npm test")] });
    renderWithRouter(<MenuBar />, api);
    await flush();
    expect(menus.at(-1)?.allPaused).toBe(false);
    act(() => onAction?.({ kind: "pauseAll", paused: true }));
    await flush();
    // Only the one not paused yet.
    expect(setOrchestratorPaused.mock.calls).toEqual([["w-a", true]]);
    expect(menus.at(-1)?.allPaused).toBe(true);
    act(() => onAction?.({ kind: "pauseAll", paused: false }));
    await flush();
    expect(setOrchestratorPaused.mock.calls.slice(1)).toEqual([
      ["w-a", false],
      ["w-b", false],
    ]);
    expect(menus.at(-1)?.allPaused).toBe(false);
  });

  it("offers no Pause all without workspaces", async () => {
    asks.setState({ all: [workspaceAsking("t-a", "0", "npm test")] });
    renderWithRouter(<MenuBar />, api);
    await flush();
    expect(menus.at(-1)).not.toHaveProperty("allPaused");
  });
});
