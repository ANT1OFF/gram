import type { TerminalEvent } from "@gram/contracts";

import { resubscribing } from "../connection";
import { isNotFound, isNotImplemented } from "../errors";
import { iterate, run, type RpcContext } from "../rpc-client";
import type { TerminalApi } from "./types";

/** `TerminalApi` over the RPC client. */
export const terminalRpc = ({ client, connection }: RpcContext): TerminalApi => ({
  terminalOpen: (input) => run(client["terminal.open"](input)),
  terminalInput: (terminalId, data) => run(client["terminal.input"]({ terminalId, data })),
  terminalResize: (terminalId, cols, rows) =>
    run(client["terminal.resize"]({ terminalId, cols, rows })),
  terminalClose: (terminalId) => run(client["terminal.close"]({ terminalId })),
  terminalList: (threadId) => run(client["terminal.list"](threadId ? { threadId } : {})),
  terminalCheckShell: (shell) => run(client["terminal.checkShell"]({ shell })),
  terminalFeed: (terminalId, signal) =>
    throughExit(
      resubscribing(
        (s) => iterate(client["terminal.subscribe"]({ terminalId }), s),
        connection,
        signal,
        {
          // A terminal the server no longer has (it restarted) is the view's to explain.
          final: (error) => isNotFound(error) || isNotImplemented(error),
        },
      ),
    ),
});

/**
 * Reopened after a dropped connection, each time with a `replay` the view resets to, but ended at
 * `exit`: the server ends the stream there for good, and reopening it would only replay the exit.
 */
async function* throughExit(events: AsyncIterable<TerminalEvent>): AsyncGenerator<TerminalEvent> {
  for await (const event of events) {
    yield event;
    if (event.type === "exit") return;
  }
}
