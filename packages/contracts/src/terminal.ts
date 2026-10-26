import * as Schema from "effect/Schema";
import { TerminalId, ThreadId } from "./ids.ts";

export const TerminalOpened = Schema.Struct({
  terminalId: TerminalId,
  cwd: Schema.String,
  shell: Schema.String,
});
export type TerminalOpened = typeof TerminalOpened.Type;

export const TerminalInfo = Schema.Struct({
  terminalId: TerminalId,
  threadId: Schema.optionalKey(ThreadId),
  cwd: Schema.String,
  shell: Schema.String,
  /** False once the shell has exited. */
  alive: Schema.Boolean,
});
export type TerminalInfo = typeof TerminalInfo.Type;

export const TerminalEvent = Schema.Union([
  /** The capped scrollback, sent once on subscribe before any `data`. */
  Schema.Struct({ type: Schema.Literal("replay"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("data"), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    code: Schema.optionalKey(Schema.Int),
    signal: Schema.optionalKey(Schema.String),
  }),
]);
export type TerminalEvent = typeof TerminalEvent.Type;
