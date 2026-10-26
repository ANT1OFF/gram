import { iterate, run, type RpcContext } from "../rpc-client";
import type { TerminalApi } from "./types";

/** `TerminalApi` over the RPC client. */
export const terminalRpc = ({ client }: RpcContext): TerminalApi => ({
  terminalOpen: (input) => run(client["terminal.open"](input)),
  terminalInput: (terminalId, data) => run(client["terminal.input"]({ terminalId, data })),
  terminalResize: (terminalId, cols, rows) =>
    run(client["terminal.resize"]({ terminalId, cols, rows })),
  terminalClose: (terminalId) => run(client["terminal.close"]({ terminalId })),
  terminalList: (threadId) => run(client["terminal.list"](threadId ? { threadId } : {})),
  terminalCheckShell: (shell) => run(client["terminal.checkShell"]({ shell })),
  // Not resubscribing: the stream ends for good after `exit`; a remount re-subscribes and replays.
  terminalFeed: (terminalId, signal) =>
    iterate(client["terminal.subscribe"]({ terminalId }), signal),
});
