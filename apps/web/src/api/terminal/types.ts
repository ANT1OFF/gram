import type {
  ShellCheck,
  TerminalEvent,
  TerminalId,
  TerminalInfo,
  TerminalOpened,
  ThreadId,
} from "@gram/contracts";

import type { RpcPayload } from "../rpc-types";

/** `terminal.open`'s payload: `cwd` defaults to the thread's checkout, else `agents.defaultFolder`. */
export type TerminalOpenInput = RpcPayload<"terminal.open">;

/** `terminal.*`: shells for the Terminal tab and their live output. */
export interface TerminalApi {
  terminalOpen(input: TerminalOpenInput): Promise<TerminalOpened>;
  terminalInput(terminalId: TerminalId, data: string): Promise<void>;
  terminalResize(terminalId: TerminalId, cols: number, rows: number): Promise<void>;
  terminalClose(terminalId: TerminalId): Promise<void>;
  terminalList(threadId?: ThreadId): Promise<readonly TerminalInfo[]>;
  /** Resolves a `terminal.shell` value (profile, name or path) the way a new terminal would. */
  terminalCheckShell(shell: string): Promise<ShellCheck>;
  /** The scrollback (`replay`), then live `data`; ends after `exit` or when `signal` aborts. */
  terminalFeed(terminalId: TerminalId, signal: AbortSignal): AsyncIterable<TerminalEvent>;
}
