import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  type TerminalEvent,
  type TerminalId,
  type ThreadId,
  ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { terminalsThroughHost } from "../terminal/host-terminals.ts";
import type { Terminals } from "../terminal/terminals.ts";
import { spawnLocalHost } from "./child.ts";

const THREAD = "thread-on-the-host" as ThreadId;

/** The server's own terminals, telling a terminal opened here from one opened on the host. */
const serverTerminals = (opened: Array<string>): Terminals => ({
  open: (request) =>
    Effect.sync(() => {
      opened.push(request.command ?? "shell");
      return { terminalId: "in-server" as TerminalId, cwd: "/", shell: "/bin/sh" };
    }),
  input: () => Effect.void,
  resize: () => Effect.void,
  close: () => Effect.void,
  list: () => Effect.succeed([]),
  subscribe: () => Stream.empty,
  snapshot: () => Effect.succeed([]),
});

const output = (events: ReadonlyArray<TerminalEvent>) =>
  events.map((event) => (event.type === "exit" ? "" : event.data)).join("");

/** The host process's terminals, routed as the server routes them, with what they reported. */
const routed = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-host-terminals-")));
  yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
  const host = yield* spawnLocalHost;
  const roots: Array<string> = [];
  const heldThreads = new Set<ThreadId>();
  /** Counts hold checks; the one numbered `holdOn` finds the thread held. */
  const holdChecks = { count: 0, holdOn: 0 };
  const closed = yield* Queue.unbounded<ThreadId>();
  const opened: Array<string> = [];
  const terminals = yield* terminalsThroughHost(
    host.terminals,
    host.gone,
    serverTerminals(opened),
    {
      threadFolder: () => Effect.succeed(dir),
      defaultFolder: Effect.succeed(undefined),
      settingsShell: Effect.succeed(undefined),
      path: Effect.sync(() => process.env["PATH"] ?? ""),
      roots: {
        add: (threadId, pid) => void roots.push(`add ${threadId} ${pid}`),
        remove: (pid) => void roots.push(`remove ${pid}`),
      },
      held: (threadId) => {
        holdChecks.count++;
        return heldThreads.has(threadId) || holdChecks.count === holdChecks.holdOn;
      },
      closedThreads: Stream.fromQueue(closed),
    },
  );
  return { host, terminals, roots, heldThreads, holdChecks, closed, opened, dir };
});

const eventually = <A>(check: () => A | undefined, label: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      const value = check();
      if (value !== undefined) return value;
      yield* Effect.sleep("25 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

describe.skipIf(process.platform === "win32")("terminals through the host process", () => {
  it.live(
    "opens a thread's terminal on the host, in the thread's folder, and counts its shell",
    () =>
      Effect.gen(function* () {
        const { host, terminals, roots, opened, dir } = yield* routed;
        const terminal = yield* terminals.open({
          threadId: THREAD,
          cols: 80,
          rows: 24,
          shell: "/bin/sh",
          command: "echo on-the-host-$((6*7))",
        });
        expect(terminal.cwd).toBe(dir);
        expect(opened).toEqual([]);
        const events = yield* terminals
          .subscribe(terminal.terminalId)
          .pipe(Stream.runCollect, Effect.timeout("20 seconds"));
        expect(output(events)).toContain("on-the-host-42");
        expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
        const [added] = yield* eventually(
          () => (roots.length === 2 ? roots : undefined),
          "the shell's start and end",
        );
        expect(added).toMatch(new RegExp(`^add ${THREAD} \\d+$`));
        expect(roots[1]).toBe(`remove ${added!.split(" ")[2]}`);
        const [listed] = yield* terminals.list(THREAD);
        expect(listed).toMatchObject({ terminalId: terminal.terminalId, alive: false });
        expect(host.hello.capabilities).toContain("terminals");
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "holds a closing thread's terminals, and closes them with the thread",
    () =>
      Effect.gen(function* () {
        const { terminals, heldThreads, closed } = yield* routed;
        const terminal = yield* terminals.open({
          threadId: THREAD,
          cols: 80,
          rows: 24,
          shell: "/bin/sh",
        });
        heldThreads.add(THREAD);
        const refused = yield* terminals.input(terminal.terminalId, "echo x\n").pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "InvalidState" });
        const notOpened = yield* terminals
          .open({ threadId: THREAD, cols: 80, rows: 24, shell: "/bin/sh" })
          .pipe(Effect.flip);
        expect(notOpened).toMatchObject({ _tag: "InvalidState" });
        yield* Queue.offer(closed, THREAD);
        yield* Effect.gen(function* () {
          for (;;) {
            const left = yield* terminals.list(THREAD);
            if (left.length === 0) return;
            yield* Effect.sleep("25 millis");
          }
        }).pipe(Effect.timeout("20 seconds"));
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "a host that goes ends its shells, and new terminals open in the server",
    () =>
      Effect.gen(function* () {
        const { host, terminals, roots, opened } = yield* routed;
        const terminal = yield* terminals.open({
          threadId: THREAD,
          cols: 80,
          rows: 24,
          shell: "/bin/sh",
        });
        yield* eventually(() => (roots.length === 1 ? roots : undefined), "the shell's start");
        const watching = yield* terminals
          .subscribe(terminal.terminalId)
          .pipe(Stream.runCollect, Effect.forkScoped);
        process.kill(host.hello.pid, "SIGKILL");
        const events = yield* Fiber.await(watching).pipe(Effect.timeout("10 seconds"));
        // The shell went with its host, so the tab sees it end.
        expect(Exit.isSuccess(events) ? events.value.at(-1) : events).toEqual({ type: "exit" });
        yield* eventually(() => (roots.length === 2 ? roots : undefined), "the shell uncounted");
        expect(roots[1]).toMatch(/^remove \d+$/);
        expect(yield* terminals.list(THREAD)).toEqual([]);
        yield* terminals.open({ threadId: THREAD, cols: 80, rows: 24, command: "true" });
        expect(opened).toEqual(["true"]);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "takes up the shells a host kept for threads it still has, and closes the ones nothing owns",
    () =>
      Effect.gen(function* () {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-host-terminals-")));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        const host = yield* spawnLocalHost;
        const GONE = "thread-closed-meanwhile" as ThreadId;
        // Opened by a main Gram before this one: nothing here remembers them.
        const shell = { cwd: dir, cols: 80, rows: 24, shell: "/bin/sh" };
        const kept = yield* host.terminals.open(
          { ...shell, threadId: THREAD },
          { path: process.env["PATH"] ?? "" },
        );
        const orphan = yield* host.terminals.open(
          { ...shell, threadId: GONE },
          { path: process.env["PATH"] ?? "" },
        );
        const opened: Array<string> = [];
        const terminals = yield* terminalsThroughHost(
          host.terminals,
          host.gone,
          serverTerminals(opened),
          {
            // Only THREAD is still stored and placed here.
            threadFolder: (threadId) =>
              threadId === THREAD
                ? Effect.succeed(dir)
                : Effect.fail(new ThreadNotFound({ threadId })),
            defaultFolder: Effect.succeed(undefined),
            settingsShell: Effect.succeed(undefined),
            path: Effect.sync(() => process.env["PATH"] ?? ""),
            closedThreads: Stream.empty,
          },
        );
        const listed = () =>
          host.terminals.list(undefined).pipe(Effect.map((all) => all.map((t) => t.terminalId)));
        // The shell whose thread is gone is closed as this connection starts.
        yield* Effect.gen(function* () {
          while ((yield* listed()).includes(orphan.terminalId)) yield* Effect.sleep("25 millis");
        }).pipe(Effect.timeout("20 seconds"));
        // The kept one's input reaches it on the host, not the server's terminals.
        const watching = yield* terminals
          .subscribe(kept.terminalId)
          .pipe(Stream.runCollect, Effect.forkScoped);
        yield* terminals.input(kept.terminalId, "echo adopted-$((6*7)); exit\n");
        const events = yield* Fiber.join(watching).pipe(Effect.timeout("20 seconds"));
        expect(output(events)).toContain("adopted-42");
        // And its close reaches it there too. Before this change both went to the server's
        // terminals, and the host's shell ran on.
        yield* terminals.close(kept.terminalId);
        expect(yield* listed()).toEqual([]);
        expect(opened).toEqual([]);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "closes a shell whose thread was held while its open crossed to the host",
    () =>
      Effect.gen(function* () {
        const { terminals, holdChecks } = yield* routed;
        // The first check, before the open is sent, passes; the second, after it returns, holds.
        holdChecks.holdOn = 2;
        const refused = yield* terminals
          .open({ threadId: THREAD, cols: 80, rows: 24, shell: "/bin/sh" })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "InvalidState" });
        expect(yield* terminals.list(THREAD)).toEqual([]);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "kills a shell that ignores its hangup when the host process stops",
    () =>
      Effect.gen(function* () {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-host-terminals-")));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        const pidFile = join(dir, "pid");
        const scope = yield* Scope.make();
        const host = yield* spawnLocalHost.pipe(Scope.provide(scope));
        yield* host.terminals.open(
          {
            cwd: dir,
            cols: 80,
            rows: 24,
            shell: "/bin/sh",
            command: `trap '' HUP; echo $$ > ${pidFile}; while :; do sleep 1; done`,
          },
          { path: process.env["PATH"] ?? "" },
        );
        const pid = yield* eventually(() => {
          try {
            const text = readFileSync(pidFile, "utf8").trim();
            return text === "" ? undefined : Number(text);
          } catch {
            return undefined;
          }
        }, "the shell's pid");
        yield* Scope.close(scope, Exit.void);
        const alive = () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        yield* eventually(() => (alive() ? undefined : true), "the shell killed");
      }),
    30_000,
  );
});
