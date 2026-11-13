import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  InvalidState,
  NotFound,
  type TerminalEvent,
  type TerminalId,
  type TerminalInfo,
  type TerminalOpened,
  type HostId,
  type ThreadId,
  type ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { spawn, type IPty } from "node-pty";

import { resolveFolder } from "../fs/folders.ts";
import { BATCH_WINDOW_MS, coalesce } from "./batch.ts";
import { keptScreen, type KeptTerminals } from "./kept.ts";
import { SCROLLBACK_LIMIT, Scrollback } from "./scrollback.ts";
import { scriptShellArgs } from "../scripts/project-scripts.ts";
import { resolveShell, shellCommand, signalName, terminalEnv } from "./shell.ts";
import { ptyInvocation } from "./shell-check.ts";
import { ensureSpawnHelperExecutable } from "./spawn-helper.ts";

export const HELD = "the thread is closing, so its terminals take no input";

export interface OpenTerminal {
  readonly threadId?: ThreadId;
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell?: string;
  /** Runs this one shell line instead of an interactive shell; the terminal ends with it. */
  readonly command?: string;
  /** The project script `command` comes from, by name, for the tab. */
  readonly script?: string;
  /** The machine to open it on, for a terminal of no thread; a thread's goes where it runs. */
  readonly hostId?: HostId;
}

export interface TerminalsDeps {
  /** The thread's checkout folder. */
  readonly threadFolder: (threadId: ThreadId) => Effect.Effect<string, ThreadNotFound>;
  /** `agents.defaultFolder`, for a terminal opened with neither a thread nor a cwd. */
  readonly defaultFolder: Effect.Effect<string | undefined>;
  /** `terminal.shell`, the Windows shell profile. */
  readonly settingsShell: Effect.Effect<string | undefined>;
  /** The login-shell PATH. */
  readonly path: Effect.Effect<string>;
  /** Threads as they close; their terminals close with them. */
  readonly closedThreads: Stream.Stream<ThreadId>;
  /** Registers a thread's shells as process roots for its port chips and busy terminals. */
  readonly roots?: {
    add(threadId: ThreadId, pid: number, terminalId: TerminalId): void;
    remove(pid: number): void;
  };
  /** Threads whose terminals take no new shell or input for now (`TerminalGate`). */
  readonly held?: (threadId: ThreadId) => boolean;
  readonly scrollbackLimit?: number;
  readonly batchWindowMs?: number;
  /**
   * Where a thread's open terminals are kept while they run, so the next start of this host shows
   * each one's last screen above a fresh shell in its folder. Absent, nothing is kept.
   */
  readonly kept?: KeptTerminals;
  /** How long after output a terminal's tail is kept; one write covers what came meanwhile. */
  readonly keepDelayMs?: number;
}

/**
 * What a terminal opens with when its caller has read the settings already (a host process the
 * server opens it on, which has no settings of its own): they stand in for `settingsShell` and
 * `path`.
 */
export interface OpenSettings {
  readonly settingsShell?: string | undefined;
  readonly path: string;
}

export interface Terminals {
  open(
    request: OpenTerminal,
    settings?: OpenSettings,
  ): Effect.Effect<TerminalOpened, ThreadNotFound | NotFound | InvalidState>;
  input(terminalId: TerminalId, data: string): Effect.Effect<void, NotFound | InvalidState>;
  resize(
    terminalId: TerminalId,
    cols: number,
    rows: number,
  ): Effect.Effect<void, NotFound | InvalidState>;
  /** Kills the shell and waits for it to exit; subscribers see the `exit` event. */
  close(terminalId: TerminalId): Effect.Effect<void, NotFound>;
  list(threadId?: ThreadId): Effect.Effect<ReadonlyArray<TerminalInfo>>;
  /** The scrollback as one `replay`, then live output in batches, ending after `exit`. */
  subscribe(terminalId: TerminalId): Stream.Stream<TerminalEvent, NotFound>;
  /** A thread's terminals with their raw scrollback as it stands, oldest first. */
  snapshot(threadId: ThreadId): Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
}

export interface TerminalSnapshot extends TerminalInfo {
  /** The replay a subscribing Terminal tab is sent: raw PTY output, escape sequences included. */
  readonly scrollback: string;
  /** Output older than `scrollback` was dropped at the cap. */
  readonly scrollbackCut: boolean;
  /** The PTY's size now, which is what the output was laid out for. */
  readonly cols: number;
  readonly rows: number;
  readonly exitCode?: number;
}

type ExitEvent = Extract<TerminalEvent, { type: "exit" }>;

interface Terminal {
  readonly info: Omit<TerminalInfo, "alive">;
  readonly pty: IPty;
  /** The PATH its shell started with. */
  readonly path: string;
  /** A keep of its tail waiting to be written. */
  keepTimer: ReturnType<typeof setTimeout> | undefined;
  readonly scrollback: Scrollback;
  readonly listeners: Set<(event: TerminalEvent) => void>;
  exit: ExitEvent | undefined;
  readonly exited: Promise<void>;
}

/** How long a hung-up shell gets to exit before SIGKILL, and then to be reaped. */
const REAP_TIMEOUT_MS = 3_000;

/** How long after output a terminal's tail is kept, by default. */
const KEEP_DELAY_MS = 1_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs `f`, failing with its error's message as an `InvalidState` if it throws. */
const attempt = (f: () => void) =>
  Effect.try({ try: f, catch: (error) => new InvalidState({ message: message(error) }) });

const kill = (pty: IPty, signal?: string) => {
  try {
    pty.kill(signal);
  } catch {
    // Already gone, or Windows, which takes no signal names.
  }
};

/**
 * Pseudo-terminals for the Terminal tab. Every terminal is killed and reaped when the scope closes
 * (server shutdown), and a thread's terminals close when the thread closes.
 */
export const makeTerminals = (deps: TerminalsDeps): Effect.Effect<Terminals, never, Scope.Scope> =>
  Effect.gen(function* () {
    const terminals = new Map<TerminalId, Terminal>();
    const limit = deps.scrollbackLimit ?? SCROLLBACK_LIMIT;
    const batchWindow = deps.batchWindowMs ?? BATCH_WINDOW_MS;
    const keepDelay = deps.keepDelayMs ?? KEEP_DELAY_MS;
    /** Set as the scope closes: what runs now is kept for the next start, not forgotten. */
    let shuttingDown = false;

    /** Writes `terminal`'s tail now, while a thread's shell still runs in it. */
    const keep = (terminal: Terminal) => {
      clearTimeout(terminal.keepTimer);
      terminal.keepTimer = undefined;
      const threadId = terminal.info.threadId;
      if (deps.kept === undefined || threadId === undefined || terminal.exit !== undefined) return;
      try {
        deps.kept.write({
          terminalId: terminal.info.terminalId,
          threadId,
          cwd: terminal.info.cwd,
          shell: terminal.info.shell,
          path: terminal.path,
          cols: terminal.pty.cols,
          rows: terminal.pty.rows,
          tail: terminal.scrollback.toReplay(),
          cut: terminal.scrollback.cut,
        });
      } catch {
        // A full or read-only disk: the terminal works on, and only its tail goes unkept.
      }
    };
    const keepSoon = (terminal: Terminal) => {
      if (deps.kept === undefined || terminal.keepTimer !== undefined || shuttingDown) return;
      terminal.keepTimer = setTimeout(() => keep(terminal), keepDelay);
    };
    /** Drops what was kept of a terminal that ended or was closed: it doesn't come back. */
    const forget = (terminal: Terminal) => {
      clearTimeout(terminal.keepTimer);
      terminal.keepTimer = undefined;
      if (deps.kept === undefined || shuttingDown) return;
      try {
        deps.kept.remove(terminal.info.terminalId);
      } catch {
        // Gone already.
      }
    };

    const find = (terminalId: TerminalId): Effect.Effect<Terminal, NotFound> =>
      Effect.suspend(() => {
        const terminal = terminals.get(terminalId);
        return terminal === undefined
          ? Effect.fail(new NotFound({ entity: "terminal", id: terminalId }))
          : Effect.succeed(terminal);
      });

    const running = (terminalId: TerminalId) =>
      find(terminalId).pipe(
        Effect.flatMap((terminal) =>
          terminal.exit === undefined
            ? Effect.succeed(terminal)
            : Effect.fail(new InvalidState({ message: "The terminal's shell has exited" })),
        ),
      );

    const cwdFor = (request: OpenTerminal) =>
      Effect.gen(function* () {
        const threadFolder =
          request.threadId === undefined ? undefined : yield* deps.threadFolder(request.threadId);
        const folder = request.cwd ?? threadFolder ?? (yield* deps.defaultFolder) ?? homedir();
        return yield* resolveFolder(folder);
      });

    /**
     * Opens a terminal; with `restore`, under a kept terminal's id with its old screen above the
     * new shell.
     */
    const spawnTerminal = (
      request: OpenTerminal,
      settings: OpenSettings | undefined,
      restore?: { readonly terminalId: TerminalId; readonly seed: string },
    ) =>
      Effect.gen(function* () {
        const cwd = yield* cwdFor(request);
        const shell = shellCommand(
          request.shell,
          settings === undefined ? yield* deps.settingsShell : settings.settingsShell,
          process.env,
          process.platform,
        );
        const resolved = resolveShell(shell.file, process.platform, process.env["PATH"] ?? "");
        if (!resolved.found) return yield* new InvalidState({ message: resolved.message });
        const pathValue = settings === undefined ? yield* deps.path : settings.path;
        const env = terminalEnv(process.env, pathValue, process.platform);
        const args =
          request.command === undefined
            ? shell.args
            : scriptShellArgs(shell, request.command, process.platform);
        const invocation = ptyInvocation(resolved.file, args, process.platform, process.env);
        // Checked after the awaits above, right before the spawn, so a hold taken meanwhile counts.
        if (request.threadId !== undefined && deps.held?.(request.threadId) === true) {
          return yield* new InvalidState({ message: HELD });
        }
        const pty = yield* Effect.try({
          try: () => {
            ensureSpawnHelperExecutable();
            return spawn(invocation.file, [...invocation.args], {
              name: "xterm-256color",
              cols: request.cols,
              rows: request.rows,
              cwd,
              env,
            });
          },
          catch: (error) =>
            new InvalidState({ message: `Can't start ${shell.file}: ${message(error)}` }),
        });

        const terminalId = restore?.terminalId ?? (randomUUID() as TerminalId);
        const exited = Promise.withResolvers<void>();
        const terminal: Terminal = {
          info: {
            terminalId,
            ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
            cwd,
            shell: shell.file,
            ...(request.script === undefined ? {} : { script: request.script }),
          },
          pty,
          path: pathValue,
          keepTimer: undefined,
          scrollback: new Scrollback(limit),
          listeners: new Set(),
          exit: undefined,
          exited: exited.promise,
        };
        if (restore !== undefined) terminal.scrollback.append(restore.seed);
        // The line a script runs, dimmed, so its output reads under the command that made it.
        if (request.command !== undefined)
          terminal.scrollback.append(`\x1b[2m$ ${request.command}\x1b[0m\r\n`);
        pty.onData((data) => {
          terminal.scrollback.append(data);
          for (const listener of terminal.listeners) listener({ type: "data", data });
          keepSoon(terminal);
        });
        pty.onExit(({ exitCode, signal }) => {
          const name = signalName(signal);
          terminal.exit = {
            type: "exit",
            code: exitCode,
            ...(name === undefined ? {} : { signal: name }),
          };
          for (const listener of terminal.listeners) listener(terminal.exit);
          // Its program ended while the host ran: nothing was lost, so nothing comes back.
          forget(terminal);
          deps.roots?.remove(pty.pid);
          exited.resolve();
        });
        terminals.set(terminalId, terminal);
        if (request.threadId !== undefined) deps.roots?.add(request.threadId, pty.pid, terminalId);
        keepSoon(terminal);
        return {
          terminalId,
          cwd,
          shell: shell.file,
          ...(request.script === undefined ? {} : { script: request.script }),
        };
      });

    const open: Terminals["open"] = (request, settings) => spawnTerminal(request, settings);

    const waitForExit = (terminal: Terminal) =>
      Effect.race(
        Effect.promise(() => terminal.exited).pipe(Effect.as(true)),
        Effect.sleep(REAP_TIMEOUT_MS).pipe(Effect.as(false)),
      );

    const reap = (terminal: Terminal) =>
      Effect.gen(function* () {
        if (terminal.exit !== undefined) return;
        yield* Effect.sync(() => kill(terminal.pty));
        if (yield* waitForExit(terminal)) return;
        yield* Effect.sync(() => kill(terminal.pty, "SIGKILL"));
        yield* waitForExit(terminal);
      });

    const close: Terminals["close"] = (terminalId) =>
      find(terminalId).pipe(
        Effect.flatMap((terminal) =>
          Effect.suspend(() => {
            terminals.delete(terminalId);
            forget(terminal);
            return reap(terminal);
          }),
        ),
      );

    const subscribe: Terminals["subscribe"] = (terminalId) =>
      Stream.unwrap(
        find(terminalId).pipe(
          Effect.map((terminal) =>
            Stream.callback<TerminalEvent>(
              (queue) =>
                Effect.acquireRelease(
                  // Snapshot and registration happen in one synchronous block, so no output can land
                  // between the replay and the first live chunk.
                  Effect.sync(() => {
                    Queue.offerUnsafe(queue, {
                      type: "replay",
                      data: terminal.scrollback.toReplay(),
                    });
                    if (terminal.exit !== undefined) {
                      Queue.offerUnsafe(queue, terminal.exit);
                      Queue.endUnsafe(queue);
                      return undefined;
                    }
                    const listener = (event: TerminalEvent) => {
                      Queue.offerUnsafe(queue, event);
                      if (event.type === "exit") Queue.endUnsafe(queue);
                    };
                    terminal.listeners.add(listener);
                    return listener;
                  }),
                  (listener) =>
                    Effect.sync(() => {
                      if (listener !== undefined) terminal.listeners.delete(listener);
                    }),
                ),
              // Unbounded: `offerUnsafe` drops on a full buffer, and dropped output corrupts the screen.
              { bufferSize: Number.POSITIVE_INFINITY },
            ).pipe(
              Stream.groupedWithin(1024, batchWindow),
              Stream.map(coalesce),
              Stream.flattenIterable,
            ),
          ),
        ),
      );

    const list: Terminals["list"] = (threadId) =>
      Effect.sync(() =>
        [...terminals.values()]
          .filter((t) => threadId === undefined || t.info.threadId === threadId)
          .map((t) => ({
            ...t.info,
            alive: t.exit === undefined,
            ...(t.exit?.code === undefined ? {} : { exitCode: t.exit.code }),
            ...(t.exit?.signal === undefined ? {} : { signal: t.exit.signal }),
          })),
      );

    const snapshot: Terminals["snapshot"] = (threadId) =>
      Effect.sync(() =>
        [...terminals.values()]
          .filter((t) => t.info.threadId === threadId)
          .map((t) => ({
            ...t.info,
            alive: t.exit === undefined,
            scrollback: t.scrollback.toReplay(),
            scrollbackCut: t.scrollback.cut,
            cols: t.pty.cols,
            rows: t.pty.rows,
            ...(t.exit?.code === undefined ? {} : { exitCode: t.exit.code }),
          })),
      );

    const closeAll = (filter: (terminal: Terminal) => boolean) =>
      Effect.forEach(
        [...terminals.values()].filter(filter),
        (terminal) => close(terminal.info.terminalId).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      );

    yield* deps.closedThreads.pipe(
      Stream.runForEach((threadId) => closeAll((t) => t.info.threadId === threadId)),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        // Kept as they stand before their shells are hung up, which the next start shows again.
        for (const terminal of terminals.values()) keep(terminal);
        shuttingDown = true;
        return closeAll(() => true);
      }),
    );

    // What the last run of this host kept: each thread's terminal that was open when it ended comes
    // back under its id, in its folder, with a fresh shell below its old screen. The command it
    // ran is never run again. One whose thread or folder is gone stays gone.
    if (deps.kept !== undefined) {
      for (const kept of deps.kept.takeAll()) {
        const restored = yield* Effect.gen(function* () {
          yield* deps.threadFolder(kept.threadId);
          const seed = yield* Effect.promise(() => keptScreen(kept));
          return yield* spawnTerminal(
            {
              threadId: kept.threadId,
              cwd: kept.cwd,
              cols: kept.cols,
              rows: kept.rows,
              shell: kept.shell,
            },
            { path: kept.path },
            { terminalId: kept.terminalId, seed },
          );
        }).pipe(Effect.exit);
        if (Exit.isFailure(restored)) {
          yield* Effect.logInfo("terminals: a kept terminal didn't come back").pipe(
            Effect.annotateLogs({ terminalId: kept.terminalId }),
          );
          continue;
        }
        const terminal = terminals.get(kept.terminalId);
        if (terminal !== undefined) keep(terminal);
      }
    }

    return {
      open,
      input: (terminalId, data) =>
        running(terminalId).pipe(
          Effect.flatMap((t) =>
            t.info.threadId !== undefined && deps.held?.(t.info.threadId) === true
              ? Effect.fail(new InvalidState({ message: HELD }))
              : attempt(() => t.pty.write(data)),
          ),
        ),
      resize: (terminalId, cols, rows) =>
        running(terminalId).pipe(Effect.flatMap((t) => attempt(() => t.pty.resize(cols, rows)))),
      close,
      list,
      subscribe,
      snapshot,
    } satisfies Terminals;
  });
