import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { InvalidState, NotFound, ThreadNotFound } from "../errors.ts";
import { HostId, TerminalId, ThreadId } from "../ids.ts";
import { ShellCheck } from "../shell-check.ts";
import { TerminalEvent, TerminalInfo, TerminalOpened } from "../terminal.ts";
import { errors, PositiveInt } from "./shared.ts";

/** Terminals (node-pty): a shell in a thread's checkout or any folder, and its live output. */
export const TerminalRpcs = RpcGroup.make(
  Rpc.make("terminal.open", {
    payload: {
      threadId: Schema.optionalKey(ThreadId),
      /** Defaults to the thread's checkout, else `agents.defaultFolder`, else home. */
      cwd: Schema.optionalKey(Schema.String),
      cols: PositiveInt,
      rows: PositiveInt,
      /** Defaults to the login shell (`terminal.shell` on Windows). */
      shell: Schema.optionalKey(Schema.String),
      /**
       * Runs the thread's project script of this name (`projects.scripts`) instead of an
       * interactive shell, in the thread's checkout or its `cwd` there; the terminal ends with it.
       * Needs `threadId`, and takes no `cwd`. Only the user's click or key sends it: no agent tool
       * does.
       */
      script: Schema.optionalKey(Schema.String),
      /**
       * Signs that joined machine's own Claude Code in: a shell there, in its home folder, with
       * `claude /login` typed but not run, for the user to run with Return. The line is fixed
       * here; it takes no `threadId`, `cwd`, `shell` or `script`. Only the Sign in buttons on
       * Settings → Machines and the Machine picker send it.
       */
      signIn: Schema.optionalKey(HostId),
    },
    success: TerminalOpened,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  Rpc.make("terminal.input", {
    payload: { terminalId: TerminalId, data: Schema.String },
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("terminal.resize", {
    payload: { terminalId: TerminalId, cols: PositiveInt, rows: PositiveInt },
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("terminal.close", { payload: { terminalId: TerminalId }, error: errors(NotFound) }),
  Rpc.make("terminal.list", {
    payload: { threadId: Schema.optionalKey(ThreadId) },
    success: Schema.Array(TerminalInfo),
    error: errors(),
  }),
  Rpc.make("terminal.subscribe", {
    payload: { terminalId: TerminalId },
    success: TerminalEvent,
    error: errors(NotFound),
    stream: true,
  }),
  Rpc.make("terminal.checkShell", {
    payload: { shell: Schema.String },
    success: ShellCheck,
    error: errors(),
  }),
);
