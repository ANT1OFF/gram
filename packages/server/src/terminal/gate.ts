import type { ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface TerminalGateShape {
  /**
   * Turns away new terminals and terminal input for the thread until the returned release runs:
   * for a close that must not remove a checkout under a command typed after its check.
   */
  readonly hold: (threadId: ThreadId) => Effect.Effect<Effect.Effect<void>>;
  readonly held: (threadId: ThreadId) => boolean;
}

/** Which threads' terminals are held shut while a close only at rest runs. */
export class TerminalGate extends Context.Service<TerminalGate, TerminalGateShape>()(
  "@gram/server/TerminalGate",
) {
  static readonly layer = Layer.sync(TerminalGate, () => {
    const holds = new Map<ThreadId, number>();
    return TerminalGate.of({
      hold: (threadId) =>
        Effect.sync(() => {
          holds.set(threadId, (holds.get(threadId) ?? 0) + 1);
          let released = false;
          return Effect.sync(() => {
            if (released) return;
            released = true;
            const left = (holds.get(threadId) ?? 1) - 1;
            if (left > 0) holds.set(threadId, left);
            else holds.delete(threadId);
          });
        }),
      held: (threadId) => holds.has(threadId),
    });
  });
}
