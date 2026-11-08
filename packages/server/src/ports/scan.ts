// One machine-wide sweep of listening ports and processes, which the port chips attribute to
// threads. A machine's host runs it, so another machine's host can run its own.

import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import { homedir } from "node:os";
import { childrenOf, scanCommands, type Command, type ProcessRow } from "./pure.ts";

/** One sweep of the machine: listening ports by pid, and the process tree as ppid → children. */
export interface PortScan {
  readonly listening: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly children: ReadonlyMap<number, ReadonlyArray<number>>;
  /** Every process by pid, for what runs in the terminals; none found when left out. */
  readonly processes?: ReadonlyMap<number, ProcessRow>;
}

/** `lsof` + `ps`, or `netstat` + CIM on Windows. */
export const liveScan: Effect.Effect<PortScan, unknown, Proc> = Effect.gen(function* () {
  const proc = yield* Proc;
  const commands = scanCommands(process.platform);
  const run = (command: Command) =>
    proc.run(command.file, command.args, {
      cwd: homedir(),
      timeoutMs: 10_000,
      maxOutputBytes: 16_000_000,
    });
  const [listeners, processes] = yield* Effect.all(
    [run(commands.listeners), run(commands.processes)],
    { concurrency: 2 },
  );
  const rows = commands.parseProcesses(processes.stdout);
  return {
    listening: commands.parseListeners(listeners.stdout),
    children: childrenOf(rows),
    processes: rows,
  };
});
