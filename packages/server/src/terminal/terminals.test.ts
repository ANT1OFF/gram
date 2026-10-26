import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "@effect/vitest";
import {
  InvalidState,
  NotFound,
  ThreadNotFound,
  type TerminalEvent,
  type TerminalId,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { spawn } from "node-pty";

import { plainTail } from "./plain-text.ts";
import { resolveShell, WINDOWS_SHELLS } from "./shell.ts";
import { ensureSpawnHelperExecutable } from "./spawn-helper.ts";
import { makeTerminals, type Terminals } from "./terminals.ts";

const isWindows = process.platform === "win32";

/**
 * What the tests type into the shell. Every marker is computed by the shell, because the pty echoes
 * typed input and the echoed command line must never match.
 */
const script = isWindows
  ? {
      // ConPTY with Windows PowerShell, as the Terminal tab uses by default.
      shell: "powershell.exe",
      printMarker: 'echo "sb-$(6*7)"',
      printPid: 'echo "pid-$PID-end"',
      printSize:
        'echo "size-$($Host.UI.RawUI.WindowSize.Height)-$($Host.UI.RawUI.WindowSize.Width)"',
      flood: "echo ('x' * 10000); echo \"sb-$(6*7)\"",
    }
  : {
      shell: "/bin/sh",
      printMarker: "echo sb-$((6*7))",
      printPid: "echo pid-$$-end",
      printSize: "echo size-$(stty size | tr ' ' -)",
      flood: "head -c 10000 /dev/zero | tr '\\0' x; echo; echo sb-$((6*7))",
    };

/** Starts a throwaway PTY, so a host that can't (no ConPTY, no prebuild) skips with a reason. */
const ptyProbe = ((): { available: true } | { available: false; reason: string } => {
  ensureSpawnHelperExecutable();
  try {
    const probe = isWindows
      ? spawn("cmd.exe", ["/c", "exit 0"], {})
      : spawn("/bin/sh", ["-c", "exit 0"], {});
    try {
      probe.kill();
    } catch {
      // Already exited.
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
})();
if (!ptyProbe.available) {
  console.warn(`terminal tests skipped: no pty could start (${ptyProbe.reason})`);
}

const THREAD = "thread-terminal-test" as ThreadId;
const SHELL = script.shell;

/** A temp folder and a terminal runtime whose `terminal.shell` setting is `settingsShell`. */
const setupWith = (settingsShell?: string, held?: (threadId: ThreadId) => boolean) =>
  Effect.gen(function* () {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "gram-terminal-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(folder, { recursive: true, force: true })),
    );
    const closedThreads = yield* Queue.unbounded<ThreadId>();
    const terminals = yield* makeTerminals({
      threadFolder: (threadId) =>
        threadId === THREAD
          ? Effect.succeed(folder)
          : Effect.fail(new ThreadNotFound({ threadId })),
      defaultFolder: Effect.succeed(undefined),
      settingsShell: Effect.succeed(settingsShell),
      path: Effect.succeed(process.env["PATH"] ?? ""),
      closedThreads: Stream.fromQueue(closedThreads),
      scrollbackLimit: 4096,
      ...(held === undefined ? {} : { held }),
    });
    return { folder, closedThreads, terminals };
  });

const setup = setupWith();

/** A cold PowerShell under ConPTY on a loaded CI runner has taken close to 30 s to answer. */
const ANSWER_DEADLINE = "90 seconds";
const RETYPE_INTERVAL = "10 seconds";

/**
 * Subscribes, types `command` and collects events until the output so far, escape sequences
 * stripped, matches `marker` (or the shell exits). The command is retyped every 10 s until then, in
 * case the shell wasn't reading input yet, so it must be safe to run more than once.
 */
const typeUntil = (
  terminals: Terminals,
  terminalId: TerminalId,
  command: string,
  marker: string | RegExp,
) =>
  Effect.gen(function* () {
    let output = "";
    const collecting = yield* Effect.forkScoped(
      terminals.subscribe(terminalId).pipe(
        Stream.takeUntil((event: TerminalEvent) => {
          if (event.type === "exit") return true;
          output += event.data;
          const text = stripVTControlCharacters(output);
          return typeof marker === "string" ? text.includes(marker) : marker.test(text);
        }),
        Stream.runCollect,
        Effect.timeout(ANSWER_DEADLINE),
      ),
    );
    const typing = yield* Effect.forkScoped(
      Effect.forever(
        terminals
          .input(terminalId, `${command}\r`)
          .pipe(Effect.andThen(Effect.sleep(RETYPE_INTERVAL))),
      ),
    );
    const events = yield* Fiber.join(collecting);
    yield* Fiber.interrupt(typing);
    return events;
  });

/** The output as text, escape sequences stripped: ConPTY can move the cursor mid-line. */
const textOf = (events: ReadonlyArray<TerminalEvent>) =>
  stripVTControlCharacters(
    events.map((event) => (event.type === "exit" ? "" : event.data)).join(""),
  );

/** Reads the shell's pid by asking it. */
const shellPid = (terminals: Terminals, terminalId: TerminalId) =>
  Effect.gen(function* () {
    const marker = /pid-(\d+)-end/;
    const events = yield* typeUntil(terminals, terminalId, script.printPid, marker);
    const match = marker.exec(textOf(events));
    if (!match?.[1]) return yield* Effect.die(new Error("no pid in the shell's output"));
    return Number(match[1]);
  });

const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH";
  }
};

/** Polls until `done` holds, for up to 10 s. */
const eventually = <A, E>(effect: Effect.Effect<A, E>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* effect;
      if (done(value)) return value;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error("condition not reached within 10 s"));
  });

/** Past `ANSWER_DEADLINE`, so a slow shell fails with the deadline's error instead of vitest's. */
const TIMEOUT = 120_000;

describe.skipIf(!ptyProbe.available)("terminals", () => {
  it.live(
    "streams a replay first, then live output, and replays it to later subscribers",
    () =>
      Effect.gen(function* () {
        const { folder, terminals } = yield* setup;
        const opened = yield* terminals.open({
          threadId: THREAD,
          cols: 80,
          rows: 24,
          shell: SHELL,
        });
        expect(opened).toMatchObject({ cwd: folder, shell: SHELL });

        const events = yield* typeUntil(terminals, opened.terminalId, script.printMarker, "sb-42");
        expect(events[0]?.type).toBe("replay");
        expect(events.slice(1).every((event) => event.type === "data")).toBe(true);

        const later = yield* terminals
          .subscribe(opened.terminalId)
          .pipe(Stream.take(1), Stream.runCollect);
        expect(later[0]).toMatchObject({ type: "replay" });
        expect(textOf(later)).toContain("sb-42");

        expect(yield* terminals.list(THREAD)).toEqual([
          {
            terminalId: opened.terminalId,
            threadId: THREAD,
            cwd: folder,
            shell: SHELL,
            alive: true,
          },
        ]);

        // What `read_terminal` reads: the same scrollback, per thread.
        const [snapshot] = yield* terminals.snapshot(THREAD);
        expect(snapshot).toMatchObject({ terminalId: opened.terminalId, cwd: folder, alive: true });
        const shown = yield* Effect.promise(() =>
          plainTail(snapshot?.scrollback ?? "", 50, snapshot),
        );
        expect(shown.text).toContain("sb-42");
        expect(yield* terminals.snapshot("another-thread" as ThreadId)).toEqual([]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "resizes the pty",
    () =>
      Effect.gen(function* () {
        const { terminals } = yield* setup;
        const { terminalId } = yield* terminals.open({ cols: 80, rows: 24, shell: SHELL });
        yield* terminals.resize(terminalId, 100, 30);
        const events = yield* typeUntil(terminals, terminalId, script.printSize, "size-30-100");
        expect(textOf(events)).toContain("size-30-100");
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "close emits exit, reaps the shell and forgets the terminal",
    () =>
      Effect.gen(function* () {
        const { terminals } = yield* setup;
        const { terminalId } = yield* terminals.open({ cols: 80, rows: 24, shell: SHELL });
        const pid = yield* shellPid(terminals, terminalId);

        const collecting = yield* Effect.forkScoped(
          terminals.subscribe(terminalId).pipe(Stream.runCollect, Effect.timeout("30 seconds")),
        );
        yield* Effect.sleep("100 millis");
        yield* terminals.close(terminalId);
        const events = yield* Fiber.join(collecting);
        expect(events.at(-1)?.type).toBe("exit");
        yield* eventually(
          Effect.sync(() => isGone(pid)),
          (gone) => gone,
        );
        expect(yield* terminals.list()).toEqual([]);
        expect(yield* Effect.flip(terminals.input(terminalId, "x"))).toBeInstanceOf(NotFound);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "closes a thread's terminals when the thread closes",
    () =>
      Effect.gen(function* () {
        const { closedThreads, terminals } = yield* setup;
        const { terminalId } = yield* terminals.open({
          threadId: THREAD,
          cols: 80,
          rows: 24,
          shell: SHELL,
        });
        const other = yield* terminals.open({ cols: 80, rows: 24, shell: SHELL });
        const pid = yield* shellPid(terminals, terminalId);

        yield* Queue.offer(closedThreads, THREAD);
        yield* eventually(terminals.list(THREAD), (list) => list.length === 0);
        yield* eventually(
          Effect.sync(() => isGone(pid)),
          (gone) => gone,
        );
        expect((yield* terminals.list()).map((t) => t.terminalId)).toEqual([other.terminalId]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "reports an exited shell as not alive and refuses input",
    () =>
      Effect.gen(function* () {
        const { terminals } = yield* setup;
        const { terminalId } = yield* terminals.open({ cols: 80, rows: 24, shell: SHELL });
        const collecting = yield* Effect.forkScoped(
          terminals.subscribe(terminalId).pipe(Stream.runCollect, Effect.timeout("30 seconds")),
        );
        yield* terminals.input(terminalId, "exit 3\r");
        expect((yield* Fiber.join(collecting)).at(-1)).toMatchObject({ type: "exit", code: 3 });
        expect((yield* terminals.list())[0]?.alive).toBe(false);
        expect(yield* Effect.flip(terminals.input(terminalId, "x"))).toBeInstanceOf(InvalidState);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    "caps the replay at the scrollback limit, keeping the newest output",
    () =>
      Effect.gen(function* () {
        const { terminals } = yield* setup;
        const { terminalId } = yield* terminals.open({ cols: 80, rows: 24, shell: SHELL });
        yield* typeUntil(terminals, terminalId, script.flood, "sb-42");

        const [replay] = yield* terminals
          .subscribe(terminalId)
          .pipe(Stream.take(1), Stream.runCollect);
        expect(replay?.type).toBe("replay");
        const data = replay?.type === "replay" ? replay.data : "";
        expect(data.length).toBeLessThanOrEqual(4096);
        expect(stripVTControlCharacters(data)).toContain("sb-42");
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live("takes no new shell or input for a thread the gate holds, until it lets go", () =>
    Effect.gen(function* () {
      const holds = new Set<ThreadId>();
      const { terminals } = yield* setupWith(undefined, (threadId) => holds.has(threadId));
      const { terminalId } = yield* terminals.open({
        threadId: THREAD,
        cols: 80,
        rows: 24,
        shell: SHELL,
      });
      holds.add(THREAD);
      expect(yield* Effect.flip(terminals.input(terminalId, "echo hi\r"))).toBeInstanceOf(
        InvalidState,
      );
      const opened = yield* Effect.flip(
        terminals.open({ threadId: THREAD, cols: 80, rows: 24, shell: SHELL }),
      );
      expect(opened).toBeInstanceOf(InvalidState);
      holds.delete(THREAD);
      yield* terminals.input(terminalId, "echo hi\r");
    }).pipe(Effect.scoped),
  );

  it.live("rejects an unknown thread, a missing folder and an unknown terminal", () =>
    Effect.gen(function* () {
      const { folder, terminals } = yield* setup;
      const unknownThread = yield* Effect.flip(
        terminals.open({ threadId: "nope" as ThreadId, cols: 80, rows: 24, shell: SHELL }),
      );
      expect(unknownThread).toBeInstanceOf(ThreadNotFound);
      const missing = yield* Effect.flip(
        terminals.open({ cwd: join(folder, "does-not-exist"), cols: 80, rows: 24, shell: SHELL }),
      );
      expect(missing).toBeInstanceOf(NotFound);
      expect(yield* Effect.flip(terminals.close("nope" as TerminalId))).toBeInstanceOf(NotFound);
    }).pipe(Effect.scoped),
  );
});

/**
 * What each Windows profile types at its prompt: a marker only that shell's output can produce, so
 * the echoed command line never matches.
 */
const PROFILE_MARKERS: Readonly<Record<string, string>> = {
  powershell: 'echo "sb-$(6*7)"',
  pwsh: 'echo "sb-$(6*7)"',
  cmd: "for /l %i in (42,1,42) do @echo sb-%i",
  "git-bash": "echo sb-$((6*7))",
};

/** Why a profile's real-shell test can't run on this host, or `undefined` when it can. */
const profileSkipReason = (profile: string): string | undefined => {
  if (!isWindows) return "shell profiles only exist on Windows";
  if (!ptyProbe.available) return `no pty could start (${ptyProbe.reason})`;
  const resolved = resolveShell(WINDOWS_SHELLS[profile]!.file, "win32", process.env["PATH"] ?? "");
  return resolved.found ? undefined : resolved.message;
};

describe("Windows shell profiles", () => {
  for (const profile of Object.keys(WINDOWS_SHELLS)) {
    const reason = profileSkipReason(profile);
    if (reason !== undefined) console.warn(`terminal profile ${profile} skipped: ${reason}`);
    describe.skipIf(reason !== undefined)(
      reason === undefined ? profile : `${profile} (skipped: ${reason})`,
      () => {
        it.live(
          "spawns through the terminal runtime, runs a command and exits cleanly",
          () =>
            Effect.gen(function* () {
              const { terminals } = yield* setupWith(profile);
              const opened = yield* terminals.open({ cols: 80, rows: 24 });
              expect(opened.shell).toBe(WINDOWS_SHELLS[profile]!.file);

              const marked = yield* typeUntil(
                terminals,
                opened.terminalId,
                PROFILE_MARKERS[profile]!,
                "sb-42",
              );
              expect(textOf(marked)).toContain("sb-42");

              const exiting = yield* Effect.forkScoped(
                terminals
                  .subscribe(opened.terminalId)
                  .pipe(Stream.runCollect, Effect.timeout("30 seconds")),
              );
              yield* terminals.input(opened.terminalId, "exit\r");
              expect((yield* Fiber.join(exiting)).at(-1)).toMatchObject({ type: "exit", code: 0 });
            }).pipe(Effect.scoped),
          TIMEOUT,
        );
      },
    );
  }

  describe.skipIf(!isWindows)(
    isWindows
      ? "a shell that isn't installed"
      : "a shell that isn't installed (skipped: not Windows)",
    () => {
      it.live("fails with a clear message instead of a raw spawn error", () =>
        Effect.gen(function* () {
          const byPath = yield* setupWith("C:\\gram-missing\\shell.exe");
          expect(yield* Effect.flip(byPath.terminals.open({ cols: 80, rows: 24 }))).toMatchObject({
            _tag: "InvalidState",
            message:
              "C:\\gram-missing\\shell.exe doesn't exist. Choose an installed terminal shell in Settings.",
          });
          const byName = yield* setupWith("gram-missing-shell");
          expect(yield* Effect.flip(byName.terminals.open({ cols: 80, rows: 24 }))).toMatchObject({
            _tag: "InvalidState",
            message:
              "gram-missing-shell isn't on PATH. Choose an installed terminal shell in Settings, or give its full path.",
          });
        }).pipe(Effect.scoped),
      );
    },
  );
});
