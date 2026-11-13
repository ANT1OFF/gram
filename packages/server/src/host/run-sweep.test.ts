import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  type Carrier,
  procScan,
  psScan,
  RUN_TOKEN_ENV,
  type Scan,
  type Scanner,
  sweepRun,
  systemScanner,
} from "./run-sweep.ts";

const TOKEN = "a".repeat(32);
const OTHER = "b".repeat(32);
const ME = 501;

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake `/proc` with `processes`, each a pid, effective user, start time and environment. */
const fakeProc = (
  processes: ReadonlyArray<{ pid: number; uid: number; start: string; env: Array<string> }>,
) => {
  const root = mkdtempSync(join(tmpdir(), "gram-proc-"));
  dirs.push(root);
  for (const p of processes) {
    const dir = join(root, String(p.pid));
    mkdirSync(dir);
    writeFileSync(join(dir, "status"), `Name:\tx\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`);
    const fields = Array.from({ length: 30 }, (_, i) => (i === 18 ? p.start : "0"));
    writeFileSync(join(dir, "stat"), `${p.pid} (sh with) parens) S ${fields.join(" ")}`);
    writeFileSync(join(dir, "environ"), `${p.env.join("\0")}\0`);
  }
  return root;
};

const plainLine = (pid: number, uid: number, command: string) =>
  `  ${pid}   ${uid} Thu Nov 13 01:02:03 2026 ${command}`;

describe("the scan of a kept-running host's processes", () => {
  it("finds this user's processes by an environment entry, never by command-line text (macOS)", () => {
    const plain = [
      plainLine(101, ME, "/bin/zsh -l"),
      plainLine(102, ME, `grep ${RUN_TOKEN_ENV}=${TOKEN}`),
      plainLine(103, 502, "sleep 999"),
      plainLine(104, ME, "sleep 999"),
    ].join("\n");
    const withEnv = [
      ` 101 /bin/zsh -l HOME=/Users/x ${RUN_TOKEN_ENV}=${TOKEN} TERM=xterm`,
      // The review's reproduction: the marker in another process's arguments only.
      ` 102 grep ${RUN_TOKEN_ENV}=${TOKEN} HOME=/Users/x`,
      ` 103 sleep 999 ${RUN_TOKEN_ENV}=${TOKEN}`,
      ` 104 sleep 999 ${RUN_TOKEN_ENV}=${OTHER}`,
    ].join("\n");
    const scan = psScan([TOKEN], plain, withEnv, ME, 1);
    expect(scan).toEqual({ ok: true, carriers: [{ pid: 101, start: "Thu Nov 13 01:02:03 2026" }] });
    // Another user's process with our token, and another instance's token: never ours.
    expect(psScan([OTHER], plain, withEnv, ME, 1)).toEqual({
      ok: true,
      carriers: [{ pid: 104, start: "Thu Nov 13 01:02:03 2026" }],
    });
  });

  it("reads native ps output, its padded columns included (macOS)", () => {
    // As macOS prints it: right-aligned pid and uid, and lstart padded with blanks before the
    // command. The review's reproduction: one blank was taken, so every process read as changed.
    const plain = [
      `  101   ${ME} Thu Nov 13 01:02:03 2026     /bin/zsh -l`,
      `98765   ${ME} Wed Nov  5 23:59:01 2026     /usr/bin/sleep 999`,
    ].join("\n");
    const withEnv = [
      `  101 /bin/zsh -l HOME=/Users/x ${RUN_TOKEN_ENV}=${TOKEN}`,
      `98765 /usr/bin/sleep 999 TERM=xterm`,
    ].join("\n");
    expect(psScan([TOKEN], plain, withEnv, ME, 1)).toEqual({
      ok: true,
      carriers: [{ pid: 101, start: "Thu Nov 13 01:02:03 2026" }],
    });
    // Still a failure when the two listings disagree about a process.
    expect(
      psScan([TOKEN], plain, `  101 /bin/bash -c x A=1\n98765 /usr/bin/sleep 999`, ME, 1).ok,
    ).toBe(false);
  });

  it("calls a listing it can't read whole a failure, not an empty result (macOS)", () => {
    expect(psScan([TOKEN], "", "", ME, 1).ok).toBe(false);
    expect(psScan([TOKEN], "garbage line", "", ME, 1).ok).toBe(false);
    expect(
      psScan([TOKEN], plainLine(101, ME, "/bin/zsh -l"), " 101 /bin/bash -c x A=1", ME, 1).ok,
    ).toBe(false);
  });

  it("reads /proc by effective user, start time and environment entries (Linux)", () => {
    const proc = fakeProc([
      { pid: 10, uid: ME, start: "111", env: [`${RUN_TOKEN_ENV}=${TOKEN}`, "HOME=/h"] },
      { pid: 11, uid: 502, start: "112", env: [`${RUN_TOKEN_ENV}=${TOKEN}`] },
      { pid: 12, uid: ME, start: "113", env: [`X=${RUN_TOKEN_ENV}=${TOKEN}`] },
    ]);
    expect(procScan([TOKEN], proc, ME, 1)).toEqual({
      ok: true,
      carriers: [{ pid: 10, start: "111" }],
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "judges a process whose environment it can't read by its control group, and fails if it can't (Linux)",
    () => {
      const proc = fakeProc([
        { pid: 10, uid: ME, start: "111", env: ["A=1"] },
        { pid: 11, uid: ME, start: "112", env: ["A=1"] },
      ]);
      const UNIT = "gram-local-host-0123456789.service";
      writeFileSync(join(proc, "10", "cgroup"), `0::/user.slice/app.slice/${UNIT}\n`);
      writeFileSync(join(proc, "11", "cgroup"), "0::/user.slice/session-7.scope\n");
      chmodSync(join(proc, "10", "environ"), 0o000);
      chmodSync(join(proc, "11", "environ"), 0o000);
      expect(procScan([TOKEN], proc, ME, 1, UNIT)).toEqual({
        ok: true,
        carriers: [{ pid: 10, start: "111" }],
      });
      // Its group unreadable too: not a scan that can be trusted.
      chmodSync(join(proc, "10", "cgroup"), 0o000);
      expect(procScan([TOKEN], proc, ME, 1, UNIT).ok).toBe(false);
      expect(procScan([TOKEN], join(proc, "missing"), ME, 1).ok).toBe(false);
    },
  );
});

/** A scanner that answers `scans` in turn, the last one again once they run out. */
const scripted = (scans: ReadonlyArray<Scan>): Scanner => {
  let i = 0;
  return () => Effect.sync(() => scans[Math.min(i++, scans.length - 1)]!);
};
const has = (...carriers: Array<Carrier>): Scan => ({ ok: true, carriers });
const failed: Scan = { ok: false, reason: "ps failed" };
const one = { pid: 4242, start: "s1" };

describe("the sweep of a kept-running host's processes", () => {
  it.live("fails, and signals nothing, when the first scan fails", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const error = yield* sweepRun([TOKEN], scripted([failed]), 50, (p, s) =>
        sent.push(`${p}:${s}`),
      ).pipe(Effect.flip);
      expect(error.message).toContain("try Stop again");
      expect(sent).toEqual([]);
    }),
  );

  it.live("fails when the scan after the kill fails, rather than reading it as empty", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      // Found; still there before TERM, after the grace, before KILL; then the scan fails.
      const scans = [has(one), has(one), has(one), has(one), failed];
      const error = yield* sweepRun([TOKEN], scripted(scans), 50, (p, s) =>
        sent.push(`${p}:${s}`),
      ).pipe(Effect.flip);
      expect(error.message).toContain("after the kill");
      expect(sent).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
    }),
  );

  it.live("never signals a pid that a new process took since the scan", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      // Same pid, another start time right before the signal: not the process found.
      const scans = [has(one), has({ pid: 4242, start: "s2" }), has()];
      yield* sweepRun([TOKEN], scripted(scans), 50, (p, s) => sent.push(`${p}:${s}`));
      expect(sent).toEqual([]);
    }),
  );

  it.live("ends what it found and checks they are gone", () =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      const scans = [has(one), has(one), has()];
      expect(
        yield* sweepRun([TOKEN], scripted(scans), 50, (p, s) => sent.push(`${p}:${s}`)),
      ).toEqual({ found: 1 });
      expect(sent).toEqual(["4242:SIGTERM"]);
    }),
  );

  it.live.skipIf(process.platform !== "linux")(
    "ends a real detached descendant carrying the token, by /proc",
    () =>
      Effect.gen(function* () {
        const token = randomBytes(16).toString("hex");
        const child = spawn("setsid", ["sh", "-c", "sleep 120"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, [RUN_TOKEN_ENV]: token },
        });
        child.unref();
        yield* Effect.sleep("300 millis");
        const before = yield* systemScanner("linux")([token]);
        expect(before.ok && before.carriers.length > 0).toBe(true);
        yield* sweepRun([token], systemScanner("linux"), 1_000);
        const after = yield* systemScanner("linux")([token]);
        expect(after).toEqual({ ok: true, carriers: [] });
      }),
    20_000,
  );
});
