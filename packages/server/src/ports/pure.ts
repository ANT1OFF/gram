// Pure parsing behind port chips: which TCP ports each thread's process trees listen on, and what
// runs in the foreground of each of its terminals. macOS and Linux read `lsof` and `ps`; Windows
// reads `netstat -ano` and a CIM process listing.

export interface Command {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

/** The two probes of one scan, and the parser for the listener probe's output. */
export interface ScanCommands {
  readonly listeners: Command;
  /** Prints one process per line: pid, ppid, then (see `parseProcesses`) its group and command. */
  readonly processes: Command;
  readonly parseListeners: (stdout: string) => Map<number, Array<number>>;
  readonly parseProcesses: (stdout: string) => Map<number, ProcessRow>;
}

/** One process of the machine-wide listing. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Its process group, and its terminal's foreground group; macOS and Linux only. */
  readonly pgid?: number | undefined;
  readonly tpgid?: number | undefined;
  /** Its command line; empty where the OS won't say. */
  readonly command: string;
}

const portOf = (address: string): number | undefined => {
  const port = Number(address.slice(address.lastIndexOf(":") + 1));
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
};

const sortedPorts = (byPid: Map<number, Set<number>>): Map<number, Array<number>> =>
  new Map([...byPid].map(([pid, ports]) => [pid, [...ports].toSorted((a, b) => a - b)]));

const addPort = (byPid: Map<number, Set<number>>, pid: number, port: number) => {
  const ports = byPid.get(pid) ?? new Set<number>();
  ports.add(port);
  byPid.set(pid, ports);
};

const lines = (stdout: string) => stdout.split("\n").map((line) => line.trim());

/**
 * pid → sorted unique ports from `lsof -nP -iTCP -sTCP:LISTEN -F pn`. The `-F` format emits `p<pid>`
 * once per process and `n<address>` per socket, so command names with spaces can't shift columns.
 */
export const parseLsof = (stdout: string): Map<number, Array<number>> => {
  const byPid = new Map<number, Set<number>>();
  let pid: number | undefined;
  for (const line of lines(stdout)) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) ? parsed : undefined;
    } else if (line.startsWith("n") && pid !== undefined) {
      const port = portOf(line.slice(1));
      if (port !== undefined) addPort(byPid, pid, port);
    }
  }
  return sortedPorts(byPid);
};

/**
 * pid → sorted unique ports from `netstat -ano -p TCP`. A listening socket is recognised by its `:0`
 * foreign address rather than the state column, which Windows localises ("LISTENING", "ABHÖREN").
 */
export const parseNetstat = (stdout: string): Map<number, Array<number>> => {
  const byPid = new Map<number, Set<number>>();
  for (const line of lines(stdout)) {
    const cols = line.split(/\s+/);
    if (cols.length !== 5 || cols[0]?.toUpperCase() !== "TCP") continue;
    const [, local = "", foreign = ""] = cols;
    const pid = Number(cols[4]);
    if (!foreign.endsWith(":0") || !Number.isInteger(pid) || pid <= 0) continue;
    const port = portOf(local);
    if (port !== undefined) addPort(byPid, pid, port);
  }
  return sortedPorts(byPid);
};

const isPid = (n: number) => Number.isInteger(n) && n >= 0;

/**
 * pid → row from `ps -axo pid=,ppid=,pgid=,tpgid=,args=`: four numbers, then the command line with
 * its spaces. Anything else (headers, blank lines) is skipped.
 */
export const parsePsProcesses = (stdout: string): Map<number, ProcessRow> => {
  const rows = new Map<number, ProcessRow>();
  for (const line of lines(stdout)) {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [pid, ppid, pgid, tpgid] = match.slice(1, 5).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    if (pid === ppid) continue;
    rows.set(pid, { pid, ppid, pgid, tpgid, command: match[5] ?? "" });
  }
  return rows;
};

/** pid → row from the CIM listing's `<pid> <ppid> <command line>`, whose command may be blank. */
export const parseCimProcesses = (stdout: string): Map<number, ProcessRow> => {
  const rows = new Map<number, ProcessRow>();
  for (const line of lines(stdout)) {
    const match = /^(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!isPid(pid) || !isPid(ppid) || pid === ppid) continue;
    rows.set(pid, { pid, ppid, command: match[3] ?? "" });
  }
  return rows;
};

/** ppid → child pids. */
export const childrenOf = (rows: ReadonlyMap<number, ProcessRow>): Map<number, Array<number>> => {
  const children = new Map<number, Array<number>>();
  for (const { pid, ppid } of rows.values()) {
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return children;
};

/** `roots` and all their descendants. Cycle-safe, since Windows reuses the pids of dead parents. */
export const descendants = (
  children: ReadonlyMap<number, ReadonlyArray<number>>,
  roots: Iterable<number>,
): Set<number> => {
  const seen = new Set<number>(roots);
  const stack = [...seen];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return seen;
};

/** Each key's sorted unique listening ports across the process trees of its root pids. */
export const portsByKey = (
  roots: ReadonlyMap<string, ReadonlyArray<number>>,
  listening: ReadonlyMap<number, ReadonlyArray<number>>,
  children: ReadonlyMap<number, ReadonlyArray<number>>,
): Map<string, Array<number>> => {
  const out = new Map<string, Array<number>>();
  for (const [key, pids] of roots) {
    const ports = new Set<number>();
    for (const pid of descendants(children, pids)) {
      for (const port of listening.get(pid) ?? []) ports.add(port);
    }
    out.set(
      key,
      [...ports].toSorted((a, b) => a - b),
    );
  }
  return out;
};

export const samePorts = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
  a.length === b.length && a.every((port, i) => port === b[i]);

/** The probes for `platform`; `lsof` and `ps` everywhere but Windows. */
export const scanCommands = (platform: NodeJS.Platform): ScanCommands =>
  platform === "win32"
    ? {
        listeners: { file: "netstat", args: ["-ano", "-p", "TCP"] },
        processes: {
          file: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }",
          ],
        },
        parseListeners: parseNetstat,
        parseProcesses: parseCimProcesses,
      }
    : {
        listeners: { file: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"] },
        processes: { file: "ps", args: ["-axo", "pid=,ppid=,pgid=,tpgid=,args="] },
        parseListeners: parseLsof,
        parseProcesses: parsePsProcesses,
      };

/** ConPTY's own console host, a child of the shell that is no job of the user's. */
const CONSOLE_HOSTS = new Set(["conhost", "openconsole"]);

/**
 * What runs in the foreground of the terminal whose shell is `shell`, other than the shell itself.
 * Where there is job control (macOS, Linux) that is the leader of the terminal's foreground process
 * group, so a daemon the shell keeps in the background (a prompt's `gitstatusd`) doesn't count.
 * Windows has none, so there it is weaker: the shell's first live child that isn't its console
 * host, which includes a job it left running in the background (`start /B`, `Start-Process`).
 */
export const foregroundOf = (
  rows: ReadonlyMap<number, ProcessRow>,
  children: ReadonlyMap<number, ReadonlyArray<number>>,
  shell: number,
): ProcessRow | undefined => {
  const root = rows.get(shell);
  if (root === undefined) return undefined;
  if (root.tpgid === undefined || root.pgid === undefined) {
    return (children.get(shell) ?? [])
      .map((pid) => rows.get(pid))
      .find((row) => row !== undefined && !CONSOLE_HOSTS.has(programName(row.command)));
  }
  if (root.tpgid <= 0 || root.tpgid === root.pgid) return undefined;
  const tree = descendants(children, [shell]);
  const leader = rows.get(root.tpgid);
  if (leader !== undefined && tree.has(leader.pid)) return leader;
  // The group's leader has exited while the rest of its pipeline runs on.
  for (const pid of tree) {
    const row = rows.get(pid);
    if (row?.pgid === root.tpgid) return row;
  }
  return undefined;
};

/** Interpreters whose script says more than they do: `node …/pnpm dev` is `pnpm dev`. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl"]);

/** The first word of `text` (quotes taken off) and what follows it. */
const firstWord = (text: string): readonly [string, string] => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end !== -1) return [trimmed.slice(1, end), trimmed.slice(end + 1).trim()];
  }
  const space = trimmed.search(/\s/);
  return space === -1 ? [trimmed, ""] : [trimmed.slice(0, space), trimmed.slice(space + 1).trim()];
};

const baseName = (path: string) =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** A program's name without its folder or Windows extension, lower-cased. */
const programName = (command: string) =>
  baseName(firstWord(command)[0])
    .replace(/\.(exe|cmd|bat)$/i, "")
    .toLowerCase();

const isPath = (word: string) => word.includes("/") || word.includes("\\");

/**
 * A command line as a person would have typed it: the program without its folder, and an
 * interpreter's script in the interpreter's place. `node /opt/homebrew/bin/pnpm dev` is `pnpm dev`.
 */
export const shortCommand = (command: string, max = 200): string => {
  const [program, rest] = firstWord(command);
  let name = baseName(program).replace(/\.exe$/i, "");
  let args = rest;
  if (INTERPRETERS.has(name.toLowerCase())) {
    const [script, after] = firstWord(rest);
    if (isPath(script)) {
      name = baseName(script).replace(/\.(c|m)?js$|\.py$|\.rb$/i, "");
      args = after;
    }
  }
  const short = args === "" ? name : `${name} ${args}`;
  return short.length > max ? `${short.slice(0, max - 1)}…` : short;
};
