import type { powerSaveBlocker } from "electron";

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
      if (typeof message !== "object" || message === null) return;
      const record = message as Record<string, unknown>;
      if (record["type"] === "keepAwake" && typeof record["active"] === "boolean")
        setActive(record["active"]);
    },
    dispose: () => setActive(false),
  };
};
