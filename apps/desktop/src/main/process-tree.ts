// Kills a process main started (the server) together with everything under it: agents, their MCP
// servers, terminal shells and what runs in them. A server killed outright runs none of its
// finalizers, and SIGKILL lets no agent end its own children, so the tree is read from the live
// process table at the moment of the kill, by parent pid, never by name. Only what descends from
// the pid main recorded for its own child is touched, and a subtree the server started for the user
// to keep (an editor, a file manager: `launched`) is spared, since it may hold unsaved work.

/** What a bounded synchronous run of `ps`/PowerShell/`taskkill` gave back; undefined if it failed. */
export type RunSync = (
  file: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => { readonly status: number | null; readonly stdout: string } | undefined;

export interface KillTreeDeps {
  readonly platform: NodeJS.Platform;
  readonly run: RunSync;
  /** `process.kill`, TerminateProcess on Windows; a pid that is gone already throws, ignored. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
}

/** Long enough for `ps` on a loaded machine, short enough for a quit the user is forcing. */
const PS_TIMEOUT_MS = 1_000;
/** PowerShell's own start takes most of a second. */
const POWERSHELL_TIMEOUT_MS = 3_000;
const TASKKILL_TIMEOUT_MS = 3_000;

/** Every process as `pid ppid` lines, from `ps` or, on Windows, CIM. */
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
  if (typeof message !== "object" || message === null) return null;
  const { type, pid } = message as Record<string, unknown>;
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

/** At most this many killed processes are named, so a runaway tree can't flood the log. */
const MAX_NAMED = 16;

/**
 * Each pid's executable name, from `pid name` lines: the file name only, never its folder or
 * arguments, so the log says what was still running (`git`, `codex`) and nothing it was given.
 */
function namesByPid(table: string): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    const name = match?.[2]?.split(/[\\/]/).at(-1)?.slice(0, 64);
    if (match !== null && name !== undefined && name !== "") names.set(Number(match[1]), name);
  }
  return names;
}

/**
 * The names of `pids`, best effort and apart from the table the kill set comes from: a read that
 * fails or overflows names nothing, and never shrinks what is killed. Asked only for the few pids
 * logged, so its output stays small. Not on Windows, where another PowerShell start costs a second.
 */
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
      // A table read mid-fork can show a cycle through a reused pid.
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
    } catch {
      // ESRCH: it exited since the table was read.
    }
  };
  const windows = deps.platform === "win32";
  const [file, args, timeoutMs] = TABLE_COMMAND[windows ? "win32" : "posix"];
  const table = deps.run(file, args, timeoutMs);
  if (table?.status !== 0) {
    // `taskkill /T` can't leave anything out, so it is only for a tree with nothing to spare: an
    // orphaned agent costs less than an editor's unsaved work.
    const tree =
      windows && spared.size === 0
        ? deps.run("taskkill", ["/pid", String(root), "/T", "/F"], TASKKILL_TIMEOUT_MS)
        : undefined;
    if (tree?.status !== 0) kill(root);
    return { under: 0, names: [] };
  }
  const under = descendantsOf(childrenByParent(table.stdout.replaceAll("\r", "")), root, spared);
  // The root first, so it can't start anything more; its children keep their parent pid in the
  // table already read.
  kill(root);
  // Named while they still run; `ps -p` exits nonzero when one has gone, with the rest named.
  const names = readNames(under.slice(0, MAX_NAMED), deps);
  for (const pid of under) kill(pid);
  return { under: under.length, names };
}
