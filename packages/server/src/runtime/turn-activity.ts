import { keepAwakeOn, type TurnId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";

/** Only transitions cross the utility-process port; no window or polling is involved. */
export const makeTurnActivity = (report: (active: boolean) => void, enabled: boolean) => {
  const turns = new Set<TurnId>();
  let reported = false;
  const publish = () => {
    const active = enabled && turns.size > 0;
    if (active === reported) return;
    reported = active;
    report(active);
  };
  return {
    start: (id: TurnId) => {
      turns.add(id);
      publish();
    },
    end: (id: TurnId) => {
      turns.delete(id);
      publish();
    },
    setEnabled: (value: boolean) => {
      enabled = value;
      publish();
    },
    dispose: () => {
      turns.clear();
      publish();
    },
  };
};

export class TurnActivity extends Context.Service<
  TurnActivity,
  ReturnType<typeof makeTurnActivity>
>()("@gram/server/TurnActivity") {
  static readonly layer = Layer.effect(
    TurnActivity,
    Effect.gen(function* () {
      const settings = yield* (yield* ThreadStore).getSettings;
      // No Electron imports: browser dev and headless servers simply have no parent port.
      const port = (process as { parentPort?: { postMessage(message: unknown): void } }).parentPort;
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeTurnActivity((active) => {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron MessagePortMain
            port?.postMessage({ type: "keepAwake", active });
          }, keepAwakeOn(settings)),
        ),
        (activity) => Effect.sync(activity.dispose),
      );
    }),
  );
}
