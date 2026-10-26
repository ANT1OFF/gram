import { describe, expect, it } from "@effect/vitest";
import {
  childrenOf,
  descendants,
  foregroundOf,
  parseCimProcesses,
  parseLsof,
  parseNetstat,
  parsePsProcesses,
  portsByKey,
  samePorts,
  scanCommands,
  shortCommand,
} from "./pure.ts";

describe("parseLsof", () => {
  it("maps pids to sorted unique ports, whatever the address family", () => {
    const out = [
      "p501",
      "f23",
      "n*:3000",
      "f24",
      "n[::1]:3000",
      "p777",
      "n127.0.0.1:5173",
      "n127.0.0.1:443",
      "nnot-an-address",
      "",
    ].join("\n");
    expect(parseLsof(out)).toEqual(
      new Map([
        [501, [3000]],
        [777, [443, 5173]],
      ]),
    );
    expect(parseLsof("")).toEqual(new Map());
  });
});

describe("parseNetstat", () => {
  it("keeps listening TCP sockets, whatever the localised state name", () => {
    const out = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4120",
      "  TCP    [::]:3000              [::]:0                 LISTENING       4120",
      "  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         932",
      "  TCP    127.0.0.1:52811        127.0.0.1:5173         ESTABLISHED     932",
      "  UDP    0.0.0.0:5353           *:*                                    1044",
    ].join("\r\n");
    expect(parseNetstat(out)).toEqual(
      new Map([
        [4120, [3000]],
        [932, [5173]],
      ]),
    );
  });
});

describe("process trees", () => {
  it("parses process listings and walks descendants without looping on reused pids", () => {
    const rows = parsePsProcesses(
      "  PID  PPID  PGID TPGID ARGS\n  10  1  10  0 /sbin/init\n  11  10  11  -1 node server.js --port 3000\n  12  11  11  0\n  20  1  20  0 x\n\r\n",
    );
    expect(rows.get(11)).toEqual({
      pid: 11,
      ppid: 10,
      pgid: 11,
      tpgid: -1,
      command: "node server.js --port 3000",
    });
    expect(rows.get(12)?.command).toBe("");
    const children = childrenOf(rows);
    expect(children.get(10)).toEqual([11]);
    expect(descendants(children, [10])).toEqual(new Set([10, 11, 12]));
    const cyclic = new Map([
      [1, [2]],
      [2, [1]],
    ]);
    expect(descendants(cyclic, [1])).toEqual(new Set([1, 2]));
  });

  it("attributes listeners to every root whose tree contains them", () => {
    const children = new Map([
      [100, [101]],
      [101, [102]],
      [200, [201]],
    ]);
    const listening = new Map([
      [102, [5173, 3000]],
      [201, [8080]],
      [999, [22]],
    ]);
    const roots = new Map([
      ["t1", [100, 200]],
      ["t2", [300]],
    ]);
    expect(portsByKey(roots, listening, children)).toEqual(
      new Map([
        ["t1", [3000, 5173, 8080]],
        ["t2", []],
      ]),
    );
    expect(samePorts([3000], [3000])).toBe(true);
    expect(samePorts([3000], [3000, 5173])).toBe(false);
  });
});

/** A `ps -axo pid=,ppid=,pgid=,tpgid=,args=` listing of `rows`, parsed. */
const ps = (...rows: Array<[number, number, number, number, string]>) =>
  parsePsProcesses(rows.map((r) => r.join(" ")).join("\n"));

describe("terminal foreground", () => {
  it("finds the terminal's foreground group leader, not the shell's background daemons", () => {
    // zsh (100) with p10k's gitstatusd in the background and `pnpm dev` in the foreground.
    const busy = ps(
      [100, 1, 100, 300, "-zsh"],
      [200, 100, 200, 300, "/opt/gitstatus/gitstatusd -s -1"],
      [300, 100, 300, 300, "node /opt/homebrew/bin/pnpm dev"],
      [301, 300, 300, 300, "node vite"],
    );
    expect(foregroundOf(busy, childrenOf(busy), 100)?.pid).toBe(300);
    // At its prompt the shell is its terminal's foreground group itself.
    const idle = ps([100, 1, 100, 100, "-zsh"], [200, 100, 200, 100, "gitstatusd"]);
    expect(foregroundOf(idle, childrenOf(idle), 100)).toBeUndefined();
    // A pipeline whose first command has exited: another member of the group stands in.
    const piped = ps([100, 1, 100, 300, "-zsh"], [301, 100, 300, 300, "less"]);
    expect(foregroundOf(piped, childrenOf(piped), 100)?.command).toBe("less");
    // A group leader outside the shell's tree isn't the shell's.
    const foreign = ps([100, 1, 100, 900, "-zsh"], [900, 1, 900, 900, "other"]);
    expect(foregroundOf(foreign, childrenOf(foreign), 100)).toBeUndefined();
    expect(foregroundOf(busy, childrenOf(busy), 999)).toBeUndefined();
  });

  it("takes the shell's first child on Windows, skipping its console host", () => {
    const rows = parseCimProcesses(
      [
        "100 1 C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "150 100 \\??\\C:\\Windows\\system32\\conhost.exe 0x4",
        '300 100 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\dev\\pnpm\\bin\\pnpm.cjs" dev',
        "400 1",
      ].join("\r\n"),
    );
    expect(rows.get(400)?.command).toBe("");
    expect(foregroundOf(rows, childrenOf(rows), 100)?.pid).toBe(300);
    expect(shortCommand(rows.get(300)!.command)).toBe("pnpm dev");
    expect(foregroundOf(rows, childrenOf(rows), 400)).toBeUndefined();
  });

  it("shortens a command line to what was typed", () => {
    expect(shortCommand("node /opt/homebrew/bin/pnpm dev")).toBe("pnpm dev");
    expect(shortCommand("/usr/bin/python3 /work/manage.py runserver")).toBe("manage runserver");
    expect(shortCommand("python3 -m http.server 8000")).toBe("python3 -m http.server 8000");
    expect(shortCommand("/usr/bin/vim src/app.ts")).toBe("vim src/app.ts");
    expect(shortCommand("htop")).toBe("htop");
    expect(shortCommand(`tail -f ${"x".repeat(300)}`, 20)).toBe("tail -f xxxxxxxxxxx…");
  });
});

describe("scanCommands", () => {
  it("uses lsof and ps on macOS, netstat and CIM on Windows", () => {
    expect(scanCommands("darwin").listeners.file).toBe("lsof");
    expect(scanCommands("darwin").processes).toEqual({
      file: "ps",
      args: ["-axo", "pid=,ppid=,pgid=,tpgid=,args="],
    });
    expect(scanCommands("darwin").parseProcesses).toBe(parsePsProcesses);
    const win = scanCommands("win32");
    expect(win.listeners).toEqual({ file: "netstat", args: ["-ano", "-p", "TCP"] });
    expect(win.processes.file).toBe("powershell.exe");
    expect(win.parseListeners).toBe(parseNetstat);
    expect(win.parseProcesses).toBe(parseCimProcesses);
  });
});
