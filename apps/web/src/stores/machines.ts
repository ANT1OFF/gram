import type { MachineState } from "@gram/contracts";
import { create } from "zustand";

interface MachinesState {
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
