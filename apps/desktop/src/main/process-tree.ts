import * as Predicate from "effect/Predicate";
/**
 * What a bounded synchronous run of `ps`/PowerShell/`taskkill` gave back; undefined if it failed.
 * `pid` is the run's own process, which a process table it printed lists too.
 */
export type RunSync = (
  file: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => { readonly status: number | null; readonly stdout: string; readonly pid?: number } | undefined;

export interface KillTreeDeps {
  readonly platform: NodeJS.Platform;
  readonly run: RunSync;
  /** `process.kill`, TerminateProcess on Windows; a pid that is gone already throws, ignored. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

const PS_TIMEOUT_MS = 1_000;
const POWERSHELL_TIMEOUT_MS = 3_000;
const TASKKILL_TIMEOUT_MS = 3_000;

const TABLE_COMMAND: Readonly<Record<"posix" | "win32", readonly [string, string[], number]>> = {
  posix: ["ps", ["-A", "-o", "pid=,ppid="], PS_TIMEOUT_MS],
  win32: [
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
    ],
    POWERSHELL_TIMEOUT_MS,
  ],
};

/** The pid in the server's `{ type: "launched", pid }`, posted for each program it opened. */
export function launchedPidFromMessage(message: unknown): number | null {
  if (!Predicate.isObject(message)) return null;
  const { type, pid } = message;
  return type === "launched" && Number.isSafeInteger(pid) && Number(pid) > 1 ? Number(pid) : null;
}

/** Each pid's children, from `pid ppid` lines. */
export function childrenByParent(table: string): ReadonlyMap<number, ReadonlyArray<number>> {
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid);
    if (siblings === undefined) children.set(ppid, [pid]);
    else siblings.push(pid);
  }
  return children;
}

const MAX_NAMED = 16;

function namesByPid(table: string): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    const name = match?.[2]?.split(/[\\/]/).at(-1)?.slice(0, 64);
    if (match !== null && name !== undefined && name !== "") names.set(Number(match[1]), name);
  }
  return names;
}

function readNames(pids: ReadonlyArray<number>, deps: KillTreeDeps): ReadonlyArray<string> {
  if (pids.length === 0 || deps.platform === "win32") return [];
  const read = deps.run("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], PS_TIMEOUT_MS);
  if (read === undefined || read.stdout.trim() === "") return [];
  const names = namesByPid(read.stdout.replaceAll("\r", ""));
  return pids.map((pid) => names.get(pid) ?? "?");
}

/** What `killTree` killed beside the root: how many, and the first `MAX_NAMED` by name. */
export interface KilledTree {
  readonly under: number;
  readonly names: ReadonlyArray<string>;
}

/**
 * Every pid under `root`, parents before their children, leaving out each `spared` pid and all
 * under it; `root` itself isn't included.
 */
export function descendantsOf(
  children: ReadonlyMap<number, ReadonlyArray<number>>,
  root: number,
  spared: ReadonlySet<number> = new Set(),
): ReadonlyArray<number> {
  const found: number[] = [];
  const seen = new Set([root]);
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child) || spared.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * Kills `root` and everything under it but the `spared` subtrees, read from the process table
 * before the root goes so none is reparented out of reach. Returns what it killed beside the
 * root, for the log: a server that wouldn't stop names what it still ran. Without a table it still
 * kills the root; on Windows, when nothing is to be spared, with `taskkill /T` too, since the
 * tree's processes would be orphaned otherwise.
 */
export function killTree(
  root: number,
  deps: KillTreeDeps,
  spared: ReadonlySet<number> = new Set(),
): KilledTree {
  const kill = (pid: number) => {
    try {
      deps.kill(pid, "SIGKILL");
    } catch (_esrchItExitedSinceTheTableWasRead) {}
  };
  const windows = deps.platform === "win32";
  const [file, args, timeoutMs] = TABLE_COMMAND[windows ? "win32" : "posix"];
  const table = deps.run(file, args, timeoutMs);
  if (table?.status !== 0) {
    const tree =
      windows && spared.size === 0
        ? deps.run("taskkill", ["/pid", String(root), "/T", "/F"], TASKKILL_TIMEOUT_MS)
        : undefined;
    if (tree?.status !== 0) kill(root);
    return { under: 0, names: [] };
  }
  const under = descendantsOf(childrenByParent(table.stdout.replaceAll("\r", "")), root, spared);
  kill(root);
  const names = readNames(under.slice(0, MAX_NAMED), deps);
  for (const pid of under) kill(pid);
  return { under: under.length, names };
}
