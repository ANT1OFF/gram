import { describe, expect, it } from "vitest";

import type { RunSync } from "../process-tree.ts";
import {
  FREEZE_MS,
  processStart,
  SURVIVOR_GRACE_MS,
  sparedNow,
  watchTree,
  type TreeCheckDeps,
} from "./tree-check.ts";

/** An invented table row: pid, parent pid, process group, start. */
type Proc = readonly [pid: number, ppid: number, pgid: number, start: string];
const row = ([pid, ppid, pgid, start]: Proc) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pgid).padStart(5)} ${start}`;

/**
 * Deps over invented tables: `next` gives each read's table (undefined: the read fails); time
 * passes only by `sleep`. Signals are recorded, never sent.
 */
const fake = (next: (read: number) => ReadonlyArray<Proc> | undefined, platform = "darwin") => {
  const reads: { file: string; args: ReadonlyArray<string> }[] = [];
  const signals: string[] = [];
  let now = 0;
  const run: RunSync = (file, args) => {
    const table = next(reads.length);
    reads.push({ file, args });
    return table === undefined
      ? undefined
      : { status: 0, stdout: `${table.map(row).join("\n")}\n` };
  };
  const deps: TreeCheckDeps = {
    platform: platform as NodeJS.Platform,
    run,
    signal: (pid, signal) => signals.push(`${signal} ${pid}`),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  return { deps, reads, signals };
};
const always = (table: ReadonlyArray<Proc>) => () => table;
/** Each read takes the next table, the last one repeating. */
const sequence =
  (...tables: ReadonlyArray<ReadonlyArray<Proc> | undefined>) =>
  (read: number) =>
    tables[Math.min(read, tables.length - 1)];

const T0 = "Thu Oct 15 09:00:00 2026";
const T1 = "Thu Oct 15 09:30:00 2026";
const T2 = "Thu Oct 15 10:00:00 2026";
// 50 is the app (its group 50); 100 the server, 101 a terminal, 102 what it runs; 300 is unrelated.
const LAUNCHD: Proc = [1, 0, 1, T0];
const APP: Proc = [50, 1, 50, T0];
const SERVER: Proc = [100, 50, 50, T0];
const TERMINAL: Proc = [101, 100, 50, T1];
const RUNS: Proc = [102, 101, 50, T1];
const UNRELATED: Proc = [300, 1, 300, T0];
const LIVE = [LAUNCHD, APP, SERVER, TERMINAL, RUNS, UNRELATED];
const GONE = [LAUNCHD, APP, UNRELATED];
const none = new Map<number, string | undefined>();

describe("update tree check", () => {
  it("reads numbers and start times only, and fails closed without a table or root", () => {
    const { deps, reads } = fake(always(LIVE));
    expect(watchTree(100, deps, none)).toBeDefined();
    expect(reads).toEqual([{ file: "/bin/ps", args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="] }]);
    expect(watchTree(100, fake(() => undefined).deps, none)).toBeUndefined();
    expect(watchTree(100, fake(always(GONE)).deps, none)).toBeUndefined();
    expect(watchTree(100, fake(always(LIVE), "win32").deps, none)).toBeUndefined();
    expect(processStart(101, deps)).toBe(T1);
  });

  it("stops the whole tree and settles once two reads find nothing new", async () => {
    const { deps, signals, reads } = fake(always(LIVE));
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(signals).toEqual([
      // Once each read: two reads, the second finding nothing new.
      "SIGSTOP 100",
      "SIGSTOP 101",
      "SIGSTOP 102",
      "SIGSTOP 100",
      "SIGSTOP 101",
      "SIGSTOP 102",
    ]);
    expect(reads).toHaveLength(3);
  });

  it("takes in a child forked before the stop took hold, then settles", async () => {
    const forked: Proc = [103, 102, 50, T2];
    const { deps, signals } = fake(sequence(LIVE, LIVE, [...LIVE, forked]));
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(signals).toContain("SIGSTOP 103");
  });

  it("fails closed when the tree never settles within its bound", async () => {
    // Every read shows a new child: it never stops forking.
    const { deps } = fake((read) => [...LIVE, [1_000 + read, 102, 50, T2]]);
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(false);
    expect(await watch.survivors()).toBeUndefined();
    const { deps: unreadable } = fake(sequence(LIVE, undefined));
    expect(await watchTree(100, unreadable, none)!.freeze()).toBe(false);
  });

  it("confirms the tree gone only in two reads in a row", async () => {
    const { deps, reads, signals } = fake(sequence(LIVE, LIVE, LIVE, GONE));
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBe(0);
    // Watch, two freeze reads, two agreeing reads, and the release's own fresh read.
    expect(reads).toHaveLength(6);
    expect(signals.filter((signal) => signal.startsWith("SIGKILL"))).toEqual([]);
  });

  it("waits for reaping, and fails closed when gone in only the last read", async () => {
    const grace = SURVIVOR_GRACE_MS / 100;
    const late = fake((read) => (read < 3 + grace ? LIVE : GONE));
    const watch = watchTree(100, late.deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBeUndefined();
  });

  it("counts a process of the tree reparented to launchd, and kills it", async () => {
    // 102 was seen under 101; 101 is killed and 102, reparented, outlives it.
    const reparented: Proc = [102, 1, 50, T1];
    const { deps, signals } = fake(sequence(LIVE, LIVE, LIVE, [...GONE, reparented]));
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBe(1);
    expect(signals.at(-1)).toBe("SIGKILL 102");
  });

  it("counts a process orphaned into the server's group after its stop began", async () => {
    // Forked by 101 and orphaned before any read saw it under 101.
    const escaped: Proc = [104, 1, 50, T2];
    const { deps } = fake(sequence(LIVE, LIVE, LIVE, [...GONE, escaped]));
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBe(1);
  });

  it("leaves alone a group orphan from before the stop and anything outside the group", async () => {
    const older: Proc = [105, 1, 50, T0];
    const other: Proc = [106, 1, 600, T2];
    const { deps, signals } = fake(
      sequence([...LIVE, older], [...LIVE, older], [...LIVE, older], [...GONE, older, other]),
    );
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBe(0);
    expect(signals.some((signal) => / 10[56]$/.test(signal))).toBe(false);
  });

  it("refuses an uncertain new ancestor child in the shared app group without signaling it", async () => {
    const uncertain: Proc = [104, 50, 50, T2];
    const { deps, signals } = fake(sequence(LIVE, LIVE, LIVE, [...GONE, uncertain]), "linux");
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBeUndefined();
    expect(signals.some((signal) => signal.endsWith(" 104"))).toBe(false);
  });

  it("never takes a reused pid for a process of the tree", async () => {
    const reused: Proc = [102, 1, 700, T2];
    const { deps, signals } = fake(sequence(LIVE, LIVE, LIVE, [...GONE, reused]));
    const watch = watchTree(100, deps, none)!;
    expect(await watch.freeze()).toBe(true);
    expect(await watch.survivors()).toBe(0);
    expect(signals).not.toContain("SIGKILL 102");
  });

  describe("process groups the tree leads", () => {
    // 101 is a terminal's shell: a pty gives it its own process group, 101.
    const SHELL: Proc = [101, 100, 101, T1];
    const JOB: Proc = [102, 101, 101, T1];
    const WITH_SHELL = [LAUNCHD, APP, SERVER, SHELL, JOB, UNRELATED];

    it("counts an orphan of the terminal's group never seen under it", async () => {
      // Forked by 102 and orphaned before any read: it carries the terminal's group, not the app's.
      const escaped: Proc = [104, 1, 101, T2];
      const { deps, signals } = fake(
        sequence(WITH_SHELL, WITH_SHELL, WITH_SHELL, [...GONE, escaped]),
      );
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(await watch.survivors()).toBe(1);
      expect(signals.at(-1)).toBe("SIGKILL 104");
    });

    it("counts new orphans adopted by a Linux ancestor subreaper in the terminal's group", async () => {
      const escaped: Proc = [104, 50, 101, T2];
      const { deps, signals } = fake(
        sequence(
          WITH_SHELL,
          [...WITH_SHELL, escaped],
          [...WITH_SHELL, escaped],
          [...GONE, escaped],
        ),
        "linux",
      );
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(signals).toContain("SIGSTOP 104");
      expect(await watch.survivors()).toBe(1);
      expect(signals.at(-1)).toBe("SIGKILL 104");
    });

    it("follows adoption by a higher ancestor into the server's own group", async () => {
      const init: Proc = [40, 1, 40, T0];
      const app: Proc = [50, 40, 50, T0];
      const server: Proc = [100, 50, 100, T1];
      const live = [LAUNCHD, init, app, server];
      const escaped: Proc = [104, 40, 100, T2];
      const { deps, signals } = fake(
        sequence(live, live, live, [LAUNCHD, init, app, escaped]),
        "linux",
      );
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(await watch.survivors()).toBe(1);
      expect(signals.at(-1)).toBe("SIGKILL 104");
    });

    it("leaves an existing child alone when it is later adopted into a tree-led group", async () => {
      const older: Proc = [105, 300, 101, T0];
      const adopted: Proc = [105, 50, 101, T0];
      const live = [...WITH_SHELL, older];
      const { deps, signals } = fake(sequence(live, live, live, [...GONE, adopted]), "linux");
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(await watch.survivors()).toBe(0);
      expect(signals.some((signal) => signal.endsWith(" 105"))).toBe(false);
    });

    it("does not claim a process through an ancestor pid reused by another process", async () => {
      const ancestor: Proc = [40, 1, 40, T0];
      const app: Proc = [50, 40, 50, T0];
      const live = [LAUNCHD, ancestor, app, SERVER, SHELL, JOB];
      const reusedAncestor: Proc = [40, 1, 40, T2];
      const other: Proc = [104, 40, 101, T2];
      const { deps, signals } = fake(
        sequence(live, live, live, [LAUNCHD, reusedAncestor, other]),
        "linux",
      );
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(await watch.survivors()).toBe(0);
      expect(signals.some((signal) => / (40|104)$/.test(signal))).toBe(false);
    });

    it("stops such an orphan with the rest when it shows up during the freeze", async () => {
      const escaped: Proc = [104, 1, 101, T2];
      const { deps, signals } = fake(
        sequence(WITH_SHELL, [...WITH_SHELL, escaped], [...WITH_SHELL, escaped], GONE),
      );
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(signals).toContain("SIGSTOP 104");
      expect(await watch.survivors()).toBe(0);
    });

    it("leaves an orphan the terminal had before the stop as a quit leaves it", async () => {
      const older: Proc = [105, 1, 101, T0];
      const tables = [...WITH_SHELL, older];
      const { deps, signals } = fake(sequence(tables, tables, tables, [...GONE, older]));
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(await watch.survivors()).toBe(0);
      expect(signals.some((signal) => signal.endsWith(" 105"))).toBe(false);
    });

    it("refuses when a group number of the tree is led by another process", async () => {
      // 101 is gone and its pid, which numbers the group, now leads an unrelated one.
      const reused: Proc = [101, 1, 101, T2];
      const { deps } = fake(sequence(WITH_SHELL, WITH_SHELL, WITH_SHELL, [...GONE, reused]));
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      expect(await watch.survivors()).toBeUndefined();
    });

    it("never signals the unrelated replacement of a reused group, or anything in its group", async () => {
      // The new leader of 101 and an orphan of its own group look like the terminal's group.
      const reused: Proc = [101, 1, 101, T2];
      const itsOrphan: Proc = [107, 1, 101, T2];
      const after = [...GONE, reused, itsOrphan];
      const { deps, signals } = fake(sequence(WITH_SHELL, WITH_SHELL, WITH_SHELL, after));
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      signals.length = 0;
      expect(await watch.survivors()).toBeUndefined();
      expect(signals.filter((signal) => / (101|107)$/.test(signal))).toEqual([]);
    });
  });

  describe("release on every path", () => {
    it("continues everything it stopped when no read follows the freeze, and refuses", async () => {
      const { deps, signals } = fake(sequence(LIVE, LIVE, LIVE, undefined));
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      signals.length = 0;
      expect(await watch.survivors()).toBeUndefined();
      // No identity can be checked without a read, so nothing is killed; nothing stays stopped.
      expect(signals).toEqual(["SIGCONT 100", "SIGCONT 101", "SIGCONT 102"]);
    });

    it("kills what is left by identity when the table comes back for the release", async () => {
      // A failed read mid-count, then one for the release that still lists 102.
      const { deps, signals } = fake(sequence(LIVE, LIVE, LIVE, undefined, [...GONE, RUNS]));
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(true);
      signals.length = 0;
      expect(await watch.survivors()).toBeUndefined();
      expect(signals).toEqual(["SIGKILL 102"]);
    });

    it("releases a freeze that never settled", async () => {
      const { deps, signals } = fake((read) =>
        read < 60 ? [...LIVE, [1_000 + read, 102, 50, T2]] : undefined,
      );
      const watch = watchTree(100, deps, none)!;
      expect(await watch.freeze()).toBe(false);
      expect(await watch.survivors()).toBeUndefined();
      const stopped = new Set(
        signals.filter((s) => s.startsWith("SIGSTOP")).map((s) => s.slice(8)),
      );
      const continued = new Set(
        signals.filter((s) => s.startsWith("SIGCONT")).map((s) => s.slice(8)),
      );
      expect(continued).toEqual(stopped);
    });
  });

  describe("programs opened for the user", () => {
    const editor: Proc = [101, 100, 101, T1];
    const itsChild: Proc = [102, 101, 101, T1];
    const opened = [LAUNCHD, APP, SERVER, editor, itsChild];

    it("spares one whose start matches, with all under it", async () => {
      const { deps, signals } = fake(sequence(opened, opened, opened, [...GONE, editor, itsChild]));
      const watch = watchTree(100, deps, new Map([[101, T1]]))!;
      expect(await watch.freeze()).toBe(true);
      expect(signals).toEqual(["SIGSTOP 100", "SIGSTOP 100"]);
      expect(await watch.survivors()).toBe(0);
    });

    it("takes a pid since reused under the server as the server's own", async () => {
      const { deps, signals } = fake(always(opened));
      const watch = watchTree(100, deps, new Map([[101, T0]]))!;
      expect(await watch.freeze()).toBe(true);
      expect(signals).toContain("SIGSTOP 101");
      expect(signals).toContain("SIGSTOP 102");
    });

    it("refuses one whose start was never known", async () => {
      const { deps } = fake(always(opened));
      const watch = watchTree(100, deps, new Map([[101, undefined]]))!;
      expect(await watch.freeze()).toBe(false);
    });

    it("spares in a kill only those still themselves, or not known", () => {
      const { deps } = fake(always(opened));
      const launched = new Map<number, string | undefined>([
        [101, T1],
        [102, T0],
        [103, undefined],
        [104, T1],
      ]);
      expect(sparedNow(launched, deps)).toEqual(new Set([101, 103]));
      expect(sparedNow(launched, fake(() => undefined).deps)).toEqual(
        new Set([101, 102, 103, 104]),
      );
    });
  });

  it("bounds the freeze in time", () => {
    expect(FREEZE_MS).toBeLessThanOrEqual(2_000);
  });
});
