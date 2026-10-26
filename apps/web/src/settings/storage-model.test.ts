import type { StorageWorktree } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  bulkTargets,
  rowState,
  sizeLabel,
  sumSizes,
  workAtRisk,
  worktreeName,
} from "./storage-model";

const GB = 1024 ** 3;

const entry = (overrides: Partial<StorageWorktree> = {}): StorageWorktree => ({
  path: "/r/.worktrees/feat-x",
  repoTop: "/r",
  branch: "feat/x",
  group: "removable",
  madeByGram: true,
  lastActivity: 0,
  missing: false,
  changedFiles: 0,
  unpushed: 0,
  settled: true,
  ...overrides,
});

describe("storage model", () => {
  it("says what a removal would lose, and the state a row shows", () => {
    expect(workAtRisk(entry())).toBeUndefined();
    expect(workAtRisk(entry({ changedFiles: 3, unpushed: 1 }))).toBe(
      "3 uncommitted changes, 1 unpushed commit",
    );
    expect(workAtRisk(entry({ unreadable: true }))).toBe("git couldn't read it");
    expect(workAtRisk(entry({ missing: true, changedFiles: 2 }))).toBeUndefined();
    expect(rowState(entry({ missing: true }))).toBe("Folder gone");
    expect(rowState(entry({ pr: { number: 9, state: "MERGED" } }))).toBe("#9 merged");
    expect(rowState(entry())).toBe("In base branch");
    expect(rowState(entry({ settled: false }))).toBeUndefined();
    const { branch: _, ...detached } = entry({ path: "/tmp/agent-shell-1" });
    expect(worktreeName(detached)).toBe("agent-shell-1");
  });

  it("sums the counts that landed, and says when the total is a lower bound", () => {
    const a = entry({ path: "/a" });
    const b = entry({ path: "/b" });
    const gone = entry({ path: "/gone", missing: true });
    const done = sumSizes(
      [a, b, gone],
      new Map([
        ["/a", { bytes: GB, partial: false }],
        ["/b", { bytes: GB, partial: false }],
      ]),
    );
    expect(sizeLabel(done)).toBe("2.0 GB");
    expect(sizeLabel(sumSizes([a, b], new Map([["/a", { bytes: GB, partial: false }]])))).toBe(
      "at least 1.0 GB",
    );
    expect(
      sizeLabel(
        sumSizes(
          [a, b],
          new Map<string, { bytes: number; partial: boolean } | "error">([
            ["/a", { bytes: GB, partial: true }],
            ["/b", "error"],
          ]),
        ),
      ),
    ).toBe("at least 1.0 GB");
  });

  it("bulk actions take only what loses nothing, and never another tool's folder", () => {
    const rows = [
      entry({ path: "/clean" }),
      entry({ path: "/dirty", group: "kept", changedFiles: 1 }),
      entry({ path: "/gone", missing: true }),
      entry({ path: "/thread", group: "inUse" }),
      entry({ path: "/locked", locked: true }),
    ];
    expect(bulkTargets("removable", rows).map((t) => t.path)).toEqual(["/clean", "/gone"]);
    const foreign = [
      entry({ path: "/tmp/a", group: "foreign", madeByGram: false }),
      entry({ path: "/tmp/b", group: "foreign", madeByGram: false, missing: true }),
    ];
    expect(bulkTargets("foreign", foreign).map((t) => t.path)).toEqual(["/tmp/b"]);
    expect(bulkTargets("idle", rows)).toEqual([]);
  });
});
