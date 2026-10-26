import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  InvalidState,
  NotFound,
  type TerminalEvent,
  type TerminalId,
  type TerminalInfo,
  type TerminalOpened,
  type ThreadId,
  type ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { spawn, type IPty } from "node-pty";

import { resolveFolder } from "../fs/folders.ts";
import { BATCH_WINDOW_MS, coalesce } from "./batch.ts";
import { SCROLLBACK_LIMIT, Scrollback } from "./scrollback.ts";
import { resolveShell, shellCommand, signalName, terminalEnv } from "./shell.ts";
import { ptyInvocation } from "./shell-check.ts";
import { ensureSpawnHelperExecutable } from "./spawn-helper.ts";

const HELD = "the thread is closing, so its terminals take no input";

interface OpenTerminal {
  readonly threadId?: ThreadId;
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell?: string;
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
}

export interface Terminals {
  open(
    request: OpenTerminal,
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
  readonly scrollback: Scrollback;
  readonly listeners: Set<(event: TerminalEvent) => void>;
  exit: ExitEvent | undefined;
  readonly exited: Promise<void>;
}

/** How long a hung-up shell gets to exit before SIGKILL, and then to be reaped. */
const REAP_TIMEOUT_MS = 3_000;

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

    const open: Terminals["open"] = (request) =>
      Effect.gen(function* () {
        const cwd = yield* cwdFor(request);
        const shell = shellCommand(
          request.shell,
          yield* deps.settingsShell,
          process.env,
          process.platform,
        );
        const resolved = resolveShell(shell.file, process.platform, process.env["PATH"] ?? "");
        if (!resolved.found) return yield* new InvalidState({ message: resolved.message });
        const env = terminalEnv(process.env, yield* deps.path, process.platform);
        const invocation = ptyInvocation(resolved.file, shell.args, process.platform, process.env);
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

        const terminalId = randomUUID() as TerminalId;
        const exited = Promise.withResolvers<void>();
        const terminal: Terminal = {
          info: {
            terminalId,
            ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
            cwd,
            shell: shell.file,
          },
          pty,
          scrollback: new Scrollback(limit),
          listeners: new Set(),
          exit: undefined,
          exited: exited.promise,
        };
        pty.onData((data) => {
          terminal.scrollback.append(data);
          for (const listener of terminal.listeners) listener({ type: "data", data });
        });
        pty.onExit(({ exitCode, signal }) => {
          const name = signalName(signal);
          terminal.exit = {
            type: "exit",
            code: exitCode,
            ...(name === undefined ? {} : { signal: name }),
          };
          for (const listener of terminal.listeners) listener(terminal.exit);
          deps.roots?.remove(pty.pid);
          exited.resolve();
        });
        terminals.set(terminalId, terminal);
        if (request.threadId !== undefined) deps.roots?.add(request.threadId, pty.pid, terminalId);
        return { terminalId, cwd, shell: shell.file };
      });

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
          .map((t) => ({ ...t.info, alive: t.exit === undefined })),
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
    yield* Effect.addFinalizer(() => closeAll(() => true));

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
