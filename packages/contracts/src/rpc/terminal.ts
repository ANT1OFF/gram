import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { InvalidState, NotFound, ThreadNotFound } from "../errors.ts";
import { TerminalId, ThreadId } from "../ids.ts";
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
