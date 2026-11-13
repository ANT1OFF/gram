import type { MachineState } from "@gram/contracts";
import { create } from "zustand";

interface MachinesState {
  /**
   * The confirmed machines threads can run on, as the server last sent them (`machines.snapshot`);
   * undefined until its first snapshot, when which machines there are isn't known yet.
   */
  readonly machines: ReadonlyArray<MachineState> | undefined;
  replace(machines: ReadonlyArray<MachineState>): void;
}

/**
 * The other machines as app state: sent when the client connects, then whenever one joins, leaves,
 * connects or drops. A thread's marker reads its machine's name and state from here, on every
 * client, so nothing polls for it.
 */
export const useMachines = create<MachinesState>()((set) => ({
  machines: undefined,
  replace: (machines) => set({ machines }),
}));
