import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@gram/contracts";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { beginChildShutdownCheck, isRunning, notOrderlyExits } from "../child-process.ts";
import { ClaudeEnvironment } from "./environment.ts";
import { AsyncPushQueue } from "./input-queue.ts";
import { ClaudeSdk, type ClaudeSdkShape } from "./sdk.ts";
import { ClaudeHost, ClaudeHostLayer } from "./session.ts";

/**
 * A stand-in Claude Code CLI with the stop behaviour measured on 2.1.296 and 2.1.299 against an
 * invented provider: a turn under way runs on past the
 * end of its input; an interrupt ends it with an error result; once its input has ended and no
 * turn is under way it exits 1 if its last result was an error, else 0; SIGTERM exits 143.
 */
const STAND_IN_CLI = `
let running = false, lastError = false, crash;
process.on("SIGTERM", () => process.exit(143));
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") { running = true; console.log("running"); }
  else if (message.type === "crash") crash = message.after;
  else if (message.type === "interrupt" && running && crash !== undefined) {
    // A crash on the interrupt: no result, at most an idle state, then exit 1.
    if (crash === "idle") console.log("idle");
    setTimeout(() => process.exit(1), 50);
  }
  else if (message.type === "interrupt" && running) { running = false; lastError = true; console.log("interrupted"); }
  else if (message.type === "fail" && running) { running = false; lastError = true; console.log("failed"); }
});
lines.on("close", () => { const end = () => running ? setTimeout(end, 20) : process.exit(lastError ? 1 : 0); end(); });
setInterval(() => {}, 1e6);
console.log("up");
`;

const state = (s: "idle" | "running") =>
  ({
    type: "system",
    subtype: "session_state_changed",
    state: s,
    uuid: s,
    session_id: "s",
  }) as never;
const errorResult = (subtype: string) =>
  ({
    type: "result",
    subtype,
    is_error: true,
    terminal_reason: subtype === "error_during_execution" ? "aborted_streaming" : "completed",
    session_id: "s",
    uuid: subtype,
  }) as never;

/**
 * The Agent SDK's side of the stand-in: it spawns through `spawnClaudeCodeProcess` as the real
 * one does, writes each input to the CLI, and closes as SDK 0.3.296 does: the CLI's stdin ends,
 * and one still running 2 s later is sent SIGTERM.
 */
class StandInQuery {
  readonly output = new AsyncPushQueue<SDKMessage>();
  readonly child: ChildProcess;
  readonly up: Promise<void>;

  constructor(options: Options, prompt: AsyncIterable<SDKUserMessage>) {
    this.child = options.spawnClaudeCodeProcess!({
      command: process.execPath,
      args: ["-e", STAND_IN_CLI],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal,
    }) as unknown as ChildProcess;
    const said = createInterface({ input: this.child.stdout! });
    this.up = new Promise((resolve) => said.once("line", () => resolve()));
    said.on("line", (line) => {
      if (line === "running") this.output.push(state("running"));
      if (line === "idle") this.output.push(state("idle"));
      if (line === "interrupted" || line === "failed") {
        this.output.push(errorResult(line === "failed" ? "success" : "error_during_execution"));
        this.output.push(state("idle"));
      }
    });
    void (async () => {
      for await (const message of prompt) this.write(message);
    })();
  }

  write(message: object) {
    if (this.child.stdin?.writable === true) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  [Symbol.asyncIterator]() {
    return this.output[Symbol.asyncIterator]();
  }

  async initializationResult() {
    await this.up;
    return { commands: [], agents: [], models: [], account: {} };
  }

  interrupt() {
    this.write({ type: "interrupt" });
    return Promise.resolve();
  }

  close() {
    this.child.stdin?.end();
    const child = this.child;
    if (isRunning(child))
      setTimeout(() => {
        if (isRunning(child)) child.kill("SIGTERM");
      }, 2_000).unref();
    this.output.end();
  }
}

const open = Effect.gen(function* () {
  const queries: Array<StandInQuery> = [];
  const sdk = {
    query: ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
      const q = new StandInQuery(params.options ?? {}, params.prompt);
      queries.push(q);
      return q;
    }) as unknown as ClaudeSdkShape["query"],
    version: "0.3.296",
  } as unknown as ClaudeSdkShape;
  const layer = ClaudeHostLayer().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ClaudeSdk)(sdk),
        Layer.succeed(ClaudeEnvironment)({
          invalidate: Effect.void,
          prepare: Effect.succeed({
            binaryPath: "/stand-in/claude",
            sdkExecutable: "/stand-in/claude",
            env: { PATH: "/usr/bin:/bin", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
            warnings: [],
          }),
          // A subscription login, stated rather than read from this machine.
          checkAuth: () => Effect.void,
        }),
      ),
    ),
  );
  const scope = yield* Scope.make();
  const session = yield* Effect.gen(function* () {
    const host = yield* ClaudeHost;
    return yield* host.open({ threadId: ThreadId.make("close"), cwd: process.cwd() });
  }).pipe(Effect.provide(layer), Scope.provide(scope));
  yield* Effect.forkIn(Stream.runDrain(session.events), scope);
  return { session, scope, child: queries[0]!.child, query: queries[0]! };
});

/** Waits for `child` to exit, up to `ms`: how it ended, or undefined while it still runs. */
const exitOf = (child: ChildProcess, ms: number) =>
  Effect.promise(
    () =>
      new Promise<{ code: number | null; signal: string | null } | undefined>((resolve) => {
        if (!isRunning(child)) return resolve({ code: child.exitCode, signal: child.signalCode });
        const timer = setTimeout(() => resolve(undefined), ms);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      }),
  );

const turnUnderWay = (send: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* send;
    yield* Effect.sleep("150 millis");
  });

describe.skipIf(process.platform === "win32")("closing a Claude session's CLI", () => {
  it.live("ends a turn under way so the CLI exits by itself, with its own code", () =>
    Effect.gen(function* () {
      const { session, scope, child } = yield* open;
      yield* turnUnderWay(session.send({ text: "work" }));
      const orderly = beginChildShutdownCheck();
      yield* Scope.close(scope, Exit.void);
      // Before the SDK's own SIGTERM, 2 s after its close: the CLI ended by itself.
      expect(yield* exitOf(child, 500)).toEqual({ code: 1, signal: null });
      expect(notOrderlyExits()).toEqual([]);
      expect(orderly()).toBe(true);
    }),
  );

  it.live("ends an idle CLI by its input alone, taking exit 1 after a failed turn as clean", () =>
    Effect.gen(function* () {
      const { session, scope, child, query } = yield* open;
      yield* turnUnderWay(session.send({ text: "work" }));
      // The provider refused the turn: an error result, then idle.
      query.write({ type: "fail" });
      yield* Effect.sleep("150 millis");
      const orderly = beginChildShutdownCheck();
      yield* Scope.close(scope, Exit.void);
      expect(yield* exitOf(child, 500)).toEqual({ code: 1, signal: null });
      expect(orderly()).toBe(true);
    }),
  );

  it.live.each(["idle", "nothing"] as const)(
    "fails agents for an interrupted CLI that crashes with exit 1 and no error result (%s first)",
    (said) =>
      Effect.gen(function* () {
        const { session, scope, child, query } = yield* open;
        // An earlier turn's error result must not stand for the interrupted turn's.
        yield* turnUnderWay(session.send({ text: "work" }));
        query.write({ type: "fail" });
        yield* Effect.sleep("150 millis");
        yield* turnUnderWay(session.send({ text: "more" }));
        query.write({ type: "crash", after: said });
        const orderly = beginChildShutdownCheck();
        yield* Scope.close(scope, Exit.void);
        expect(yield* exitOf(child, 3_000)).toEqual({ code: 1, signal: null });
        expect(notOrderlyExits()).toEqual([
          { kind: "session", code: 1, signal: null, forced: false },
        ]);
        expect(orderly()).toBe(false);
      }),
    15_000,
  );

  it.live("exits 0 when it never ran a turn", () =>
    Effect.gen(function* () {
      const { scope, child } = yield* open;
      const orderly = beginChildShutdownCheck();
      yield* Scope.close(scope, Exit.void);
      expect(yield* exitOf(child, 500)).toEqual({ code: 0, signal: null });
      expect(orderly()).toBe(true);
    }),
  );

  it.live(
    "leaves a turn the interrupt doesn't end to the SDK's SIGTERM, which is not orderly",
    () =>
      Effect.gen(function* () {
        const { session, scope, child, query } = yield* open;
        yield* turnUnderWay(session.send({ text: "work" }));
        // A CLI that never answers the interrupt.
        query.interrupt = () => new Promise<void>(() => {});
        const orderly = beginChildShutdownCheck();
        yield* Scope.close(scope, Exit.void);
        expect(yield* exitOf(child, 3_000)).toEqual({ code: 143, signal: null });
        expect(notOrderlyExits()).toEqual([
          { kind: "session", code: 143, signal: null, forced: false },
        ]);
        expect(orderly()).toBe(false);
      }),
    15_000,
  );
});
