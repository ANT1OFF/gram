// Proves an update's killed server tree gone before the bundle is replaced (`server-host.ts`
// `TreeCheck`). The process table is read by number and start time only, never by name: pid,
// parent pid, process group and `lstart`. A process is known by its birth identity (pid and start
// time), so one that is reparented to launchd stays known, and a pid reused by another process is
// never taken for it.
//
// From the stop request on, the watch follows the server's tree: every process under a known one
// joins it, and so does a process orphaned since the request into a process group the tree leads
// (a terminal's shell leads its own) or into the server's own group, its parent gone before a
// read could see it. A group number the tree led that another process now leads makes what is in
// it untellable, which refuses. Before the kill the whole tree is stopped (SIGSTOP) until two reads
// in a row find nothing new, so nothing can fork past the kill. After it, the tree must be gone in
// two reads in a row. A table that can't be read, a watch that doesn't settle in time, or a
// launched program whose identity can't be told from a reused pid fails closed: the update is
// refused. Whatever the outcome, the tree is released: anything of it still alive is killed, or,
// when no read can check identities, everything stopped is continued and the update refused.

import type { RunSync } from "../process-tree.ts";

export interface TreeCheckDeps {
  readonly platform: NodeJS.Platform;
  readonly run: RunSync;
  /** `process.kill`; a pid that is gone already throws, ignored. */
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** Every process as `pid ppid pgid lstart`: numbers and a start time, nothing a process names. */
const TABLE = ["/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="]] as const;
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/;
/** Long enough for `ps -A` on a loaded machine; a read that runs over fails closed. */
const PS_TIMEOUT_MS = 2_000;
/** How long stopping the tree may take to settle before the check fails closed. */
export const FREEZE_MS = 2_000;
/** How long the killed tree gets to be reaped before what is left counts as a survivor. */
export const SURVIVOR_GRACE_MS = 2_000;
const FREEZE_POLL_MS = 20;
const POLL_MS = 100;

interface Row {
  readonly ppid: number;
  readonly pgid: number;
  readonly start: string;
}
type Table = ReadonlyMap<number, Row>;

/** A process's birth identity: its pid and when it started. */
const id = (pid: number, row: Row) => `${pid} ${row.start}`;

/** The table by pid, or undefined when it couldn't be read; never an empty table. */
function readTable(deps: TreeCheckDeps): Table | undefined {
  // `ps` is POSIX; Windows has no qualified survivor check, so an update there is refused.
  if (deps.platform === "win32") return undefined;
  const [file, args] = TABLE;
  const read = deps.run(file, args, PS_TIMEOUT_MS);
  if (read?.status !== 0) return undefined;
  const rows = new Map<number, Row>();
  for (const line of read.stdout.replaceAll("\r", "").split("\n")) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const start = match[4]!.replaceAll(/\s+/g, " ");
    rows.set(Number(match[1]), { ppid: Number(match[2]), pgid: Number(match[3]), start });
  }
  return rows.size === 0 ? undefined : rows;
}

/**
 * When `pid` started, as the table shows it, for telling it from a later process given the same
 * pid; undefined when it can't be read.
 */
export function processStart(pid: number, deps: TreeCheckDeps): string | undefined {
  return readTable(deps)?.get(pid)?.start;
}

/** What the server opened for the user, by pid: its start time, or undefined when unknown. */
export type Launched = ReadonlyMap<number, string | undefined>;

/**
 * Which `launched` pids are still those programs: their start time matches. One whose start
 * couldn't be read is kept, since a kill can't take back an editor's unsaved work; the check
 * refuses the update on it instead. A pid now another process's is left out.
 */
export function sparedNow(launched: Launched, deps: TreeCheckDeps): ReadonlySet<number> {
  if (launched.size === 0) return new Set();
  const table = readTable(deps);
  const spared = new Set<number>();
  for (const [pid, start] of launched) {
    const row = table?.get(pid);
    if (start === undefined || table === undefined || row?.start === start) spared.add(pid);
  }
  return spared;
}

export interface TreeWatch {
  /** Stops the whole tree, read until two reads agree; false when it can't be settled or told. */
  readonly freeze: () => Promise<boolean>;
  /**
   * How many of the tree are still alive once two reads agree, or after the grace; undefined when
   * the table can't be read or the watch was never settled. Kills what is left either way.
   */
  readonly survivors: () => Promise<number | undefined>;
}

/**
 * Starts following `root`'s tree, from before its stop; undefined when the table can't be read or
 * doesn't list `root`. `launched` programs with their start time matching are left out, with all
 * under them.
 */
export function watchTree(
  root: number,
  deps: TreeCheckDeps,
  launched: Launched,
): TreeWatch | undefined {
  const first = readTable(deps);
  const rootRow = first?.get(root);
  if (first === undefined || rootRow === undefined) return undefined;
  const members = new Map<number, string>([[root, rootRow.start]]);
  // Every process group the tree leads, by its leader's start: a terminal's shell leads its own.
  // The server's group, when it doesn't lead it, is shared with the app (`shared`).
  const groups = new Map<number, string>();
  const shared = rootRow.pgid === root ? undefined : rootRow.pgid;
  // Linux can adopt orphans into an ancestor subreaper instead of PID 1. Record ancestors by
  // birth identity, never by process name or an unfenced parent pid.
  const ancestors = new Map<number, string>();
  for (let pid = rootRow.ppid; pid > 1 && !ancestors.has(pid);) {
    const row = first.get(pid);
    if (row === undefined) break;
    ancestors.set(pid, row.start);
    pid = row.ppid;
  }
  // An already existing process is never claimed merely because its parent later changes.
  const before = new Set([...first].map(([pid, row]) => id(pid, row)));
  /** Members ever sent SIGSTOP, by birth identity, so none is left stopped whatever happens. */
  const stopped = new Map<number, string>();
  let ambiguous = false;
  let settled = false;

  const isMember = (pid: number, row: Row | undefined) =>
    row !== undefined && members.get(pid) === row.start;
  /** Group numbers seen led by another process than the tree's leader: never owned again. */
  const disowned = new Set<number>();
  const join = (pid: number, row: Row) => {
    members.set(pid, row.start);
    if (row.pgid === pid && !disowned.has(pid)) groups.set(pid, row.start);
  };
  join(root, rootRow);

  /** Adds every process of `table` that joins the tree; returns the pids it added. */
  const grow = (table: Table): number[] => {
    // A group of the tree now led by another process: its number was reused, and what is in it
    // can no longer be told apart. The group is disowned for good, so nothing in it is taken in,
    // stopped or killed, and the update is refused.
    for (const [pgid, start] of groups) {
      const leader = table.get(pgid);
      if (leader === undefined || leader.start === start) continue;
      ambiguous = true;
      groups.delete(pgid);
      disowned.add(pgid);
    }
    const added: number[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, row] of table) {
        if (isMember(pid, row)) continue;
        const underMember = isMember(row.ppid, table.get(row.ppid));
        const ownGroup = groups.has(row.pgid) || row.pgid === shared;
        const adoptedByAncestor =
          ancestors.has(row.ppid) && ancestors.get(row.ppid) === table.get(row.ppid)?.start;
        const newInGroup = ownGroup && !before.has(id(pid, row));
        // An ancestor's new child in the app's shared group could be unrelated. Refuse without
        // claiming or signaling it. A group led by this tree gives the missing ownership proof.
        if (!underMember && adoptedByAncestor && newInGroup && row.pgid === shared) {
          ambiguous = true;
          continue;
        }
        const orphaned =
          newInGroup && (row.ppid === 1 || (adoptedByAncestor && groups.has(row.pgid)));
        if (!underMember && !orphaned) continue;
        if (launched.has(pid)) {
          const start = launched.get(pid);
          // Unknown: can't be told from a reused pid. Matching: the user's program, spared.
          if (start === undefined) ambiguous = true;
          if (start === undefined || start === row.start) continue;
        }
        join(pid, row);
        added.push(pid);
        changed = true;
      }
    }
    return added;
  };
  grow(first);

  /** Sends `signal` to every member `table` still lists as itself. */
  const signalAll = (table: Table, signal: NodeJS.Signals) => {
    for (const [pid, start] of members) {
      if (table.get(pid)?.start !== start) continue;
      if (signal === "SIGSTOP") stopped.set(pid, start);
      send(pid, signal);
    }
  };
  const send = (pid: number, signal: NodeJS.Signals) => {
    try {
      deps.signal(pid, signal);
    } catch {
      // ESRCH: it exited since the read.
    }
  };

  /**
   * Leaves nothing of the tree stopped or alive: kills every member a fresh read still shows as
   * itself. Without a read no identity can be checked, so whatever was stopped is only continued
   * (harmless to a pid since reused), and the update is refused as unverified.
   */
  const release = () => {
    const table = readTable(deps);
    if (table !== undefined) {
      signalAll(table, "SIGKILL");
      return true;
    }
    for (const pid of stopped.keys()) send(pid, "SIGCONT");
    return false;
  };

  return {
    async freeze() {
      const deadline = deps.now() + FREEZE_MS;
      for (let reads = 0; ; reads++) {
        const table = readTable(deps);
        if (table === undefined) return false;
        const added = grow(table);
        signalAll(table, "SIGSTOP");
        // Two reads in a row with nothing new, the last after everything was stopped.
        if (reads > 0 && added.length === 0) {
          settled = !ambiguous;
          return settled;
        }
        if (deps.now() >= deadline) return false;
        await deps.sleep(FREEZE_POLL_MS);
      }
    },
    async survivors() {
      let left: number | undefined;
      let released = false;
      try {
        const deadline = deps.now() + SURVIVOR_GRACE_MS;
        let previous: number | undefined;
        for (;;) {
          const table = readTable(deps);
          if (table === undefined) break;
          grow(table);
          const alive = [...members].filter(([pid, start]) => table.get(pid)?.start === start);
          if (alive.length === 0 && previous === 0) {
            left = 0;
            break;
          }
          if (deps.now() >= deadline) {
            // Gone in one read only isn't confirmed: fail closed.
            left = alive.length > 0 ? alive.length : undefined;
            break;
          }
          previous = alive.length;
          await deps.sleep(POLL_MS);
        }
      } finally {
        released = release();
      }
      return settled && released && !ambiguous ? left : undefined;
    },
  };
}
