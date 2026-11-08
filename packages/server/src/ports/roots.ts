import type { TerminalId, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProcessRootsShape {
  add(threadId: ThreadId, pid: number, terminalId?: TerminalId): void;
  remove(pid: number): void;
  readonly all: Effect.Effect<ReadonlyArray<readonly [ThreadId, number]>>;
  /** The roots that are a terminal's shell, with the terminal. */
  readonly terminals: Effect.Effect<
    ReadonlyArray<{
      readonly threadId: ThreadId;
      readonly pid: number;
      readonly terminalId: TerminalId;
    }>
  >;
}

/** Root pids a thread owns outside its agent session: its terminals' shells. */
export class ProcessRoots extends Context.Service<ProcessRoots, ProcessRootsShape>()(
  "@gram/server/ProcessRoots",
) {
  static readonly layer: Layer.Layer<ProcessRoots> = Layer.sync(ProcessRoots, () => {
    const rootOf = new Map<number, { threadId: ThreadId; terminalId?: TerminalId | undefined }>();
    return ProcessRoots.of({
      add: (threadId, pid, terminalId) => void rootOf.set(pid, { threadId, terminalId }),
      remove: (pid) => void rootOf.delete(pid),
      all: Effect.sync(() => [...rootOf].map(([pid, root]) => [root.threadId, pid] as const)),
      terminals: Effect.sync(() =>
        [...rootOf].flatMap(([pid, { threadId, terminalId }]) =>
          terminalId === undefined ? [] : [{ threadId, pid, terminalId }],
        ),
      ),
    });
  });
}
