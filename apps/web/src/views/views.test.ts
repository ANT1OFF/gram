import type { ThreadSummary, WorkspaceState } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { parkedSoloThreads, soloThreads } from "./solo-threads";
import { useViewStore } from "./view-store";
import { viewWorkspace } from "./view-workspace";

const s = useViewStore.getState;

beforeEach(() => useViewStore.setState({ view: "chat", quiet: false, carry: undefined }));

describe("the view", () => {
  it("goes back to Chat on a route change, unless a workspace switch carries it there", () => {
    s().setView("board");
    s().routeChanged("/t/worker");
    expect(s().view).toBe("chat");

    s().setView("board");
    s().carryView("/t/orch-b");
    s().routeChanged("/t/orch-b");
    expect(s().view).toBe("board");
    // Carried once: the next route change resets it.
    s().routeChanged("/settings");
    expect(s().view).toBe("chat");

    s().setView("board");
    s().carryView("/t/orch-b");
    s().routeChanged("/t/somewhere-else");
    expect(s()).toMatchObject({ view: "chat", carry: undefined });
  });

  it("counts every pick, the view already shown included", () => {
    const before = s().picks;
    s().setView("board");
    s().setView("board");
    expect(s()).toMatchObject({ view: "board", picks: before + 2 });
    // A route change isn't a pick.
    s().routeChanged("/settings");
    expect(s()).toMatchObject({ view: "chat", picks: before + 2 });
  });

  it("keeps Quiet apart from the view", () => {
    s().setView("board");
    s().toggleQuiet();
    expect(s()).toMatchObject({ view: "board", quiet: true });
    s().setQuiet(false);
    expect(s()).toMatchObject({ view: "board", quiet: false });
  });
});

const workspace = (id: string): WorkspaceState =>
  ({
    workspace: { id, name: id, orchestratorThreadId: `orch-${id}` },
  }) as unknown as WorkspaceState;

describe("viewWorkspace", () => {
  const all = [workspace("api"), workspace("billing")];

  it("is the thread's own, else the one shown last, else the first", () => {
    expect(viewWorkspace({ workspaceId: "billing" } as never, all, "api")?.workspace.id).toBe(
      "billing",
    );
    expect(viewWorkspace(undefined, all, "billing")?.workspace.id).toBe("billing");
    expect(viewWorkspace({}, all, "gone")?.workspace.id).toBe("api");
    expect(viewWorkspace(undefined, [], "api")).toBeUndefined();
  });
});

const summary = (
  id: string,
  thread: Partial<ThreadSummary["thread"]>,
  lastActivityAt: number,
): ThreadSummary =>
  ({
    thread: { id, title: id, projectId: "p", parked: false, lastActivityAt, ...thread },
  }) as unknown as ThreadSummary;

describe("soloThreads", () => {
  it("lists the threads outside every workspace, unparked, latest first", () => {
    const threads = [
      summary("readme", {}, 3),
      summary("deps", {}, 5),
      summary("parked", { parked: true }, 9),
      summary("orch", { role: "orchestrator", workspaceId: "api" } as never, 8),
      summary("worker", { workspaceId: "api", spawnedBy: { threadId: "orch" } } as never, 7),
      // A workspace that was removed leaves its threads outside any.
      summary("left", { role: "orchestrator", workspaceId: "gone" } as never, 1),
    ];
    expect(soloThreads(threads, new Set(["api"])).map((each) => each.thread.id)).toEqual([
      "deps",
      "readme",
      "left",
    ]);
    // The parked one is under the folded Parked line instead.
    expect(parkedSoloThreads(threads, new Set(["api"])).map((each) => each.thread.id)).toEqual([
      "parked",
    ]);
  });
});
