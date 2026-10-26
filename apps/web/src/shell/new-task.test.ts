import type { Thread, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { orchestratorPane } from "./new-task";

const id = (value: string) => value as ThreadId;
// A worker and a plain thread have no role; "unknown" isn't loaded.
const threads: Record<string, Pick<Thread, "role">> = {
  orch: { role: "orchestrator" },
  worker: {},
  plain: {},
  dream: { role: "dream" },
};
const threadOf = (threadId: ThreadId) => threads[threadId];

const grid = (panes: (string | null)[], focused = 0, maximized = false) => ({
  panes: panes.map((pane) => (pane === null ? null : id(pane))),
  focused,
  maximized,
});

describe("orchestratorPane", () => {
  it("is the focused pane when it shows an orchestrator", () => {
    expect(orchestratorPane(grid(["orch"]), threadOf)).toBe(0);
    expect(orchestratorPane(grid(["worker", "orch"], 1), threadOf)).toBe(1);
  });

  it("finds an orchestrator in another pane on screen", () => {
    expect(orchestratorPane(grid(["worker", null, "orch"], 0), threadOf)).toBe(2);
  });

  it("is undefined with no orchestrator on screen", () => {
    expect(orchestratorPane(grid(["worker", "plain", "dream", null]), threadOf)).toBeUndefined();
    expect(orchestratorPane(grid([null]), threadOf)).toBeUndefined();
    // A thread not loaded yet isn't taken for one.
    expect(orchestratorPane(grid(["unknown"]), threadOf)).toBeUndefined();
  });

  it("looks only at the focused pane while it is maximized", () => {
    expect(orchestratorPane(grid(["worker", "orch"], 0, true), threadOf)).toBeUndefined();
    expect(orchestratorPane(grid(["orch", "worker"], 0, true), threadOf)).toBe(0);
  });
});
