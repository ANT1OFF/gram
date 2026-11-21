import type { RunSync } from "../process-tree.ts";

export interface TreeCheckDeps {
  readonly platform: NodeJS.Platform;
  readonly run: RunSync;
  /** `process.kill`; a pid that is gone already throws, ignored. */
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const TABLE = ["/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="]] as const;
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/;
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

const id = (pid: number, row: Row) => `${pid} ${row.start}`;

function readTable(deps: TreeCheckDeps): Table | undefined {
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
  if (read.pid !== undefined) rows.delete(read.pid);
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
  const groups = new Map<number, string>();
  const shared = rootRow.pgid === root ? undefined : rootRow.pgid;
  const ancestors = new Map<number, string>();
  for (let pid = rootRow.ppid; pid > 1 && !ancestors.has(pid);) {
    const row = first.get(pid);
    if (row === undefined) break;
    ancestors.set(pid, row.start);
    pid = row.ppid;
  }
  const before = new Set([...first].map(([pid, row]) => id(pid, row)));
  const stopped = new Map<number, string>();
  let ambiguous = false;
  let settled = false;

  const isMember = (pid: number, row: Row | undefined) =>
    row !== undefined && members.get(pid) === row.start;
  const disowned = new Set<number>();
  const join = (pid: number, row: Row) => {
    members.set(pid, row.start);
    if (row.pgid === pid && !disowned.has(pid)) groups.set(pid, row.start);
  };
  join(root, rootRow);

  const grow = (table: Table): number[] => {
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
        if (!underMember && adoptedByAncestor && newInGroup && row.pgid === shared) {
          ambiguous = true;
          continue;
        }
        const orphaned =
          newInGroup && (row.ppid === 1 || (adoptedByAncestor && groups.has(row.pgid)));
        if (!underMember && !orphaned) continue;
        if (launched.has(pid)) {
          const start = launched.get(pid);
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
    } catch (_esrchItExitedSinceTheRead) {}
  };

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
