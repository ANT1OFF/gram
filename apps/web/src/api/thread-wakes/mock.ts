import type { ThreadWake } from "@gram/contracts";

import type { MockWorld } from "../mock-world";
import type { ThreadWakesApi } from "./types";

/** The wakes the mock's plain threads have set, none until a control sets one. */
export function createThreadWakesMock(world: MockWorld) {
  let wakes: readonly ThreadWake[] = [];
  const api: ThreadWakesApi = {
    listThreadWakes: async () => {
      await world.delay(10);
      return { wakes: wakes.toSorted((a, b) => a.at - b.at) };
    },
    cancelThreadWake: async (threadId, id) => {
      const gone = wakes.filter(
        (w) => w.threadId === threadId && (id === undefined || w.id === id),
      );
      wakes = wakes.filter((w) => !gone.includes(w));
      if (gone.length > 0) world.emit({ type: "threadWakes.changed" });
      return { cancelled: gone.length };
    },
  };
  return {
    ...api,
    /** The thread's agent calls `schedule_wake`, as the server would store it. */
    simulateThreadWake(wake: ThreadWake) {
      wakes = [...wakes.filter((w) => w.id !== wake.id), wake];
      world.emit({ type: "threadWakes.changed" });
    },
  };
}
