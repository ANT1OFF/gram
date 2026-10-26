import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  childrenByParent,
  descendantsOf,
  killTree,
  launchedPidFromMessage,
  type RunSync,
} from "./process-tree.ts";

/**
 * A server (100) with an agent (101) and its MCP server (102), a shell (103) running a job (104),
 * and an editor it opened for the user (105) with a helper of its own (106).
 */
const TABLE = [
  "    1     0",
  "  100    50",
  "  101   100",
  "  102   101",
  "  103   100",
  "  104   103",
  "  105   100",
  "  106   105",
  "  200     1",
  "  201   200",
  "",
].join("\n");

/** What `ps -o pid=,comm=` gives for those pids: full executable paths, some with spaces. */
const NAMES: Readonly<Record<number, string>> = {
  101: "/Users/someone/.local/share/claude/versions/9.9.9",
  102: "node",
  103: "/bin/zsh",
  104: "/usr/bin/git",
  105: "/Applications/Editor.app/Contents/MacOS/Editor",
  106: "Editor Helper",
};

/** Answers the table read with `table` and a `-p` name read from `names`. */
const psWith =
  (table: string, names: Readonly<Record<number, string>> = NAMES): RunSync =>
  (_file, args) => {
    if (!args.includes("-p")) return { status: 0, stdout: table };
    const pids = args[args.indexOf("-p") + 1]!.split(",").map(Number);
    const known = pids.filter((pid) => names[pid] !== undefined);
    return {
      status: known.length === pids.length ? 0 : 1,
      stdout: known.map((pid) => `${pid} ${names[pid]}\n`).join(""),
    };
  };

const setup = (platform: NodeJS.Platform, run: RunSync, spared?: ReadonlySet<number>) => {
  const killed: Array<[number, string]> = [];
  const ran: Array<ReadonlyArray<string>> = [];
  const under = killTree(
    100,
    {
      platform,
      run: (file, args, timeoutMs) => {
        ran.push([file, ...args]);
        return run(file, args, timeoutMs);
      },
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        if (pid === 103) throw new Error("ESRCH");
      },
    },
    spared,
  );
  return { killed, ran, under };
};

describe("killTree", () => {
  it("kills the root and every process under it, and nothing else", () => {
    const { killed, ran, under } = setup("darwin", psWith(TABLE));
    expect(killed.map(([pid]) => pid)).toEqual([100, 101, 103, 105, 102, 104, 106]);
    expect(new Set(killed.map(([, signal]) => signal))).toEqual(new Set(["SIGKILL"]));
    expect(under).toEqual({
      under: 6,
      names: ["9.9.9", "zsh", "Editor", "node", "git", "Editor Helper"],
    });
    // The kill set comes from the numeric table alone; names are a separate read of those pids.
    expect(ran).toEqual([
      ["ps", "-A", "-o", "pid=,ppid="],
      ["ps", "-o", "pid=,comm=", "-p", "101,103,105,102,104,106"],
    ]);
  });

  it("names only what it killed, file name only, and '?' for what it couldn't read", () => {
    const { under } = setup("darwin", psWith(TABLE, { 101: "/opt/agent/bin/agent" }));
    expect(under.under).toBe(6);
    expect(under.names).toEqual(["agent", "?", "?", "?", "?", "?"]);
    // Windows names nothing rather than start PowerShell twice.
    const windows = setup("win32", psWith(TABLE));
    expect(windows.under).toEqual({ under: 6, names: [] });
    expect(windows.ran).toHaveLength(1);
    expect(setup("linux", () => undefined).under).toEqual({ under: 0, names: [] });
  });

  it("spares what the server launched for the user, and all under it", () => {
    const { killed } = setup("linux", () => ({ status: 0, stdout: TABLE }), new Set([105]));
    expect(killed.map(([pid]) => pid)).toEqual([100, 101, 103, 102, 104]);
  });

  it("reads Windows' table through CIM, CRLF and all", () => {
    const { killed, ran } = setup(
      "win32",
      () => ({ status: 0, stdout: TABLE.replaceAll("\n", "\r\n") }),
      new Set([105]),
    );
    expect(ran[0]?.[0]).toBe("powershell.exe");
    expect(killed.map(([pid]) => pid)).toEqual([100, 101, 103, 102, 104]);
  });

  it("still kills the root when the table can't be read: taskkill's tree on Windows", () => {
    expect(setup("linux", () => undefined).killed).toEqual([[100, "SIGKILL"]]);
    const windows = setup("win32", (file) =>
      file === "taskkill" ? { status: 0, stdout: "" } : undefined,
    );
    expect(windows.ran.at(-1)).toEqual(["taskkill", "/pid", "100", "/T", "/F"]);
    expect(windows.killed).toEqual([]);
    expect(setup("win32", () => undefined).killed).toEqual([[100, "SIGKILL"]]);
    // With an editor to spare, no unrestricted taskkill: the root only.
    const sparing = setup(
      "win32",
      (file) => (file === "taskkill" ? { status: 0, stdout: "" } : undefined),
      new Set([105]),
    );
    expect(sparing.ran.map(([file]) => file)).toEqual(["powershell.exe"]);
    expect(sparing.killed).toEqual([[100, "SIGKILL"]]);
  });
});

describe("descendantsOf", () => {
  it("survives a cycle a table read mid-fork can show", () => {
    expect(descendantsOf(childrenByParent("  5  4\n  4  5\n"), 4)).toEqual([5]);
  });
});

describe("launchedPidFromMessage", () => {
  it("reads a launched program's pid, and only that", () => {
    expect(launchedPidFromMessage({ type: "launched", pid: 4242 })).toBe(4242);
    expect(launchedPidFromMessage({ type: "launched", pid: 1 })).toBeNull();
    expect(launchedPidFromMessage({ type: "launched", pid: "4242" })).toBeNull();
    expect(launchedPidFromMessage({ type: "boot", pid: 4242 })).toBeNull();
  });
});

describe("killTree under a very large tree", () => {
  /** `spawnSync`'s default `maxBuffer`: past it, the run fails with ENOBUFS and gives no output. */
  const MAX_BUFFER = 1024 * 1024;
  const DESCENDANTS = 3_000;
  /** A `ps` that prints whatever columns it is asked for, failing as spawnSync does on overflow. */
  const ps: RunSync = (_file, args) => {
    const columns = args[args.indexOf("-o") + 1] ?? "";
    const only = args.includes("-p")
      ? new Set(args[args.indexOf("-p") + 1]!.split(","))
      : undefined;
    const rows = [`100 50 ${"g".repeat(500)}`];
    for (let pid = 1_000; pid < 1_000 + DESCENDANTS; pid++)
      rows.push(`${pid} ${pid === 1_000 ? 100 : pid - 1} ${"n".repeat(500)}`);
    const lines = rows
      .filter((row) => only === undefined || only.has(row.split(" ")[0]!))
      .map((row) => {
        const [pid, ppid, name] = row.split(" ");
        return columns === "pid=,ppid="
          ? `${pid} ${ppid}`
          : columns === "pid=,comm="
            ? `${pid} ${name}`
            : row;
      });
    const stdout = lines.join("\n") + "\n";
    return Buffer.byteLength(stdout) > MAX_BUFFER ? undefined : { status: 0, stdout };
  };

  it("kills every descendant even when their names don't fit the read", () => {
    const killed: number[] = [];
    const result = killTree(100, {
      platform: "darwin",
      run: ps,
      kill: (pid) => void killed.push(pid),
    });
    expect(killed).toHaveLength(DESCENDANTS + 1);
    expect(result.under).toBe(DESCENDANTS);
    expect(result.names).toEqual(Array.from({ length: 16 }, () => "n".repeat(64)));
  });

  it("still kills the whole tree when the name read fails", () => {
    const killed: number[] = [];
    const result = killTree(100, {
      platform: "darwin",
      run: (file, args, timeoutMs) => (args.includes("-p") ? undefined : ps(file, args, timeoutMs)),
      kill: (pid) => void killed.push(pid),
    });
    expect(killed).toHaveLength(DESCENDANTS + 1);
    expect(result).toEqual({ under: DESCENDANTS, names: [] });
  });
});

describe("killTree with real spawnSync overflow", () => {
  it("keeps all 3,001 kills when a name read returns ENOBUFS", () => {
    const rows = ["100 50", ...Array.from({ length: 3_000 }, (_, i) => `${i + 1_000} 100`)];
    const killed: number[] = [];
    let overflowed = false;
    const result = killTree(100, {
      platform: "darwin",
      run: (_file, args, timeoutMs) => {
        // An injected failing name read returns the large table even for a bounded -p query.
        const numeric = args.includes("pid=,ppid=");
        const output = rows.map((row) => (numeric ? row : `${row} ${"n".repeat(500)}`)).join("\n");
        const read = spawnSync(
          process.execPath,
          ["-e", 'process.stdout.write(require("node:fs").readFileSync(0))'],
          {
            encoding: "utf8",
            input: output,
            timeout: timeoutMs,
          },
        );
        if (read.error !== undefined) {
          expect((read.error as NodeJS.ErrnoException).code).toBe("ENOBUFS");
          overflowed = true;
          return undefined;
        }
        return read;
      },
      kill: (pid) => void killed.push(pid),
    });
    expect(overflowed).toBe(true);
    expect(killed).toEqual([100, ...Array.from({ length: 3_000 }, (_, i) => i + 1_000)]);
    expect(result).toEqual({ under: 3_000, names: [] });
  });
});
