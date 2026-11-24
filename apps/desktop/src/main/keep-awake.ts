import type { powerSaveBlocker } from "electron";
import * as Predicate from "effect/Predicate";

/** One blocker for every open agent turn, including workers and turns waiting for input. */
export const createKeepAwake = (blocker: Pick<typeof powerSaveBlocker, "start" | "stop">) => {
  let id: number | undefined;
  const setActive = (active: boolean) => {
    if (active && id === undefined) id = blocker.start("prevent-app-suspension");
    else if (!active && id !== undefined) {
      blocker.stop(id);
      id = undefined;
    }
  };
  return {
    accept: (message: unknown) => {
      if (!Predicate.isObject(message)) return;
      const record = message;
      if (record["type"] === "keepAwake" && typeof record["active"] === "boolean")
        setActive(record["active"]);
    },
    dispose: () => setActive(false),
  };
};
