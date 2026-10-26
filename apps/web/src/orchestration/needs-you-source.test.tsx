// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type PendingRequest,
  type RequestId,
  type ThreadId,
} from "@gram/contracts";
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import type { MockAsksSimulation } from "@/api/mock-asks";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { needsYou, splitForTree } from "@/sidebar/grouping";
import { useServerEvents } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import type * as AskModel from "./ask-model";
import { askTotals, useWorkspaceAsks } from "./ask-stack";
import { THREADS_GROUP } from "./needs-you-items";
import { resetDerivedAsks, useDerivedAsks } from "./needs-you-store";
import { NeedsYouSource, useNeedsYouList } from "./use-needs-you";

// Asks and Needs you are derived once per window (`NeedsYouSource`) and read by every view that
// shows them. Ten views used to derive them each, on every change to any thread.

const derivations = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ask-model", async (importOriginal) => {
  const real = await importOriginal<typeof AskModel>();
  return {
    ...real,
    asksOf: (...args: Parameters<typeof real.asksOf>) => {
      derivations.count++;
      return real.asksOf(...args);
    },
  };
});

/** How many times each reader rendered, by name. */
const renders = new Map<string, number>();

function AsksCount({ name }: { name: string }) {
  renders.set(name, (renders.get(name) ?? 0) + 1);
  const { count } = askTotals(useWorkspaceAsks());
  return <span data-testid={name}>{count}</span>;
}

function NeedsYouCount() {
  renders.set("needs-you", (renders.get("needs-you") ?? 0) + 1);
  return <span data-testid="needs-you">{useNeedsYouList().items.length}</span>;
}

const READERS = ["sidebar", "rail", "stack", "quiet", "menu-bar", "away", "board", "switcher"];

function Window() {
  useServerEvents();
  return (
    <>
      <NeedsYouSource />
      {READERS.map((name) => (
        <AsksCount key={name} name={name} />
      ))}
      <NeedsYouCount />
    </>
  );
}

let api: MockApi;
let sim: MockAsksSimulation;

beforeEach(async () => {
  useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  api = createMockApi({ speed: 0, autoplay: false, persist: false });
  sim = await api.simulateAsks();
  renders.clear();
});

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  resetDerivedAsks();
});

/** What the threads outside any workspace bring to Needs you beside their waits. */
const solo = () =>
  useDerivedAsks
    .getState()
    .needsYou.groups.find((group) => group.key === THREADS_GROUP)
    ?.items.filter((item) => item.kind !== "wait") ?? [];

/** How many asks every view reads now. */
const count = () => askTotals(useDerivedAsks.getState().asks).count;

const shown = (view: ReturnType<typeof renderWithApi>, name: string) =>
  Number(view.getByTestId(name).textContent);

describe("NeedsYouSource", () => {
  it("derives asks once for every reader, and a thread change that moves no ask re-renders none", async () => {
    const view = renderWithApi(<Window />, api);
    await waitFor(() => expect(shown(view, "sidebar")).toBeGreaterThan(0));
    await waitFor(() => expect(shown(view, "needs-you")).toBeGreaterThan(0));
    const asks = shown(view, "sidebar");
    for (const name of READERS) expect(shown(view, name)).toBe(asks);

    const before = new Map(renders);
    const derived = derivations.count;
    const workspaces = useDerivedAsks.getState().asks.length;
    let changes = 0;
    const unsubscribe = useThreadsStore.subscribe((s, previous) => {
      if (s.byId !== previous.byId) changes++;
    });
    // A worker with no ask, working: its status and its activity line move many times a second.
    const worker = Object.values(useThreadsStore.getState().byId).find(
      (summary) =>
        summary.thread.workspaceId === sim.workspaceId && summary.pendingRequests.length === 0,
    )!.thread.id;
    api.simulateStatus(worker, "running", "Reading a.ts");
    await waitFor(() =>
      expect(useThreadsStore.getState().statusDetail[worker]).toBe("Reading a.ts"),
    );
    api.simulateLastActivity(worker, 1_000);
    await waitFor(() =>
      expect(useThreadsStore.getState().byId[worker]?.thread.lastActivityAt).toBe(1_000),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    unsubscribe();

    expect(Object.fromEntries(renders)).toEqual(Object.fromEntries(before));
    // One derivation pass (each workspace's asks, with and without Later's, and the solo threads')
    // per change the source sees, whatever reads it: fewer passes than readers, where each reader
    // deriving its own made at least one pass apiece.
    expect(changes).toBeGreaterThan(0);
    const passes = (derivations.count - derived) / (2 * workspaces + 1);
    expect(passes).toBeGreaterThan(0);
    expect(passes).toBeLessThan(READERS.length);
  });

  it("brings a new ask to every reader", async () => {
    const view = renderWithApi(<Window />, api);
    await waitFor(() => expect(shown(view, "sidebar")).toBeGreaterThan(0));
    const asks = shown(view, "sidebar");
    const request: PendingRequest = {
      kind: "approval",
      id: "r-new" as RequestId,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "rm -rf build" },
      suggestions: [],
    };
    api.simulateRequest(sim.other.asking, request);
    await waitFor(() => expect(shown(view, "sidebar")).toBe(asks + 1));
    for (const name of READERS) expect(shown(view, name)).toBe(asks + 1);
    await waitFor(() =>
      expect(
        useDerivedAsks.getState().needsYou.items.some((item) => item.ids.includes("r-new")),
      ).toBe(true),
    );
  });

  it("lists the requests and the error of a thread outside any workspace, as the badge counts it", async () => {
    renderWithApi(<Window />, api);
    // The seed's question and plan, each a thread of its own.
    await waitFor(() =>
      expect(solo().map((item) => [item.kind, item.threadId])).toEqual(
        expect.arrayContaining([
          ["question", "t-question"],
          ["plan", "t-plan"],
        ]),
      ),
    );
    api.simulateStatus("t-deps" as ThreadId, "error");
    await waitFor(() =>
      expect(solo().some((item) => item.kind === "failure" && item.threadId === "t-deps")).toBe(
        true,
      ),
    );
    // The same threads the window title and the dock badge count, outside the workspaces.
    const workspaces = new Set<string>(
      useDerivedAsks.getState().withLater.map((w) => w.workspaceId),
    );
    const counted = splitForTree(Object.values(useThreadsStore.getState().byId), workspaces)
      .listed.filter((summary) => needsYou(summary))
      .map((summary) => summary.thread.id)
      .toSorted();
    expect([...new Set(solo().map((item) => item.threadId))].toSorted()).toEqual(counted);
  });

  it("removes a dismissed worker question from every count and keeps approvals after remount", async () => {
    const made = await api.simulateWorkerQuestions();
    const view = renderWithApi(<Window />, api);
    const key = `worker-question:${made.workspaceId}:WQ1`;
    await waitFor(() =>
      expect(useDerivedAsks.getState().needsYou.items.some((item) => item.ids.includes(key))).toBe(
        true,
      ),
    );
    const before = count();
    const approvalIds = useDerivedAsks
      .getState()
      .asks.flatMap((w) => w.asks)
      .filter((ask) => ask.worker === undefined)
      .flatMap((ask) => ask.ids);
    expect(approvalIds.length).toBeGreaterThan(0);
    await api.dismissWorkerQuestion({ workspaceId: made.workspaceId, questionId: "WQ1" });
    await waitFor(() => expect(count()).toBe(before - 1));
    for (const name of READERS) expect(shown(view, name)).toBe(before - 1);
    expect(
      useDerivedAsks
        .getState()
        .asks.flatMap((w) => w.asks)
        .filter((ask) => ask.worker === undefined)
        .flatMap((ask) => ask.ids),
    ).toEqual(approvalIds);
    view.unmount();
    resetDerivedAsks();
    const remounted = renderWithApi(<Window />, api);
    await waitFor(() => expect(shown(remounted, "sidebar")).toBe(before - 1));
    expect(useDerivedAsks.getState().needsYou.items.some((item) => item.ids.includes(key))).toBe(
      false,
    );
  });

  it("puts a snoozed ask away for Later and brings it back when it wakes", async () => {
    const view = renderWithApi(<Window />, api);
    await waitFor(() => expect(shown(view, "sidebar")).toBeGreaterThan(0));
    const asks = count();
    const ask = useDerivedAsks.getState().asks.flatMap((w) => w.asks)[0]!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const settings = useServerSettings.getState().settings!;
      useServerSettings.setState({
        settings: {
          ...settings,
          inbox: { ...settings.inbox, snoozed: ask.ids.map((id) => `${id} ${Date.now() + 5_000}`) },
        },
      });
      expect(count()).toBe(asks - 1);
      expect(
        useDerivedAsks
          .getState()
          .needsYou.later.some((each) => each.item.ids.includes(ask.ids[0]!)),
      ).toBe(true);
      vi.advanceTimersByTime(4_000);
      expect(count()).toBe(asks - 1);
      vi.advanceTimersByTime(1_500);
      expect(count()).toBe(asks);
    } finally {
      vi.useRealTimers();
    }
  });
});
