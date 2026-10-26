import { create } from "zustand";

/** Where the folder browser opens before anything has been browsed. */
const DEFAULT_BROWSE_PATH = "~/Documents/code";

interface ProjectPickerState {
  browserOpen: boolean;
  /** The folder the browser shows; kept across visits to `/new`. */
  browsePath: string;
  setBrowserOpen: (open: boolean) => void;
  browseTo: (path: string) => void;
}

const initial = { browserOpen: false, browsePath: DEFAULT_BROWSE_PATH };

export const useProjectPickerStore = create<ProjectPickerState>()((set) => ({
  ...initial,
  setBrowserOpen: (browserOpen) => set({ browserOpen }),
  browseTo: (browsePath) => set({ browsePath }),
}));

export const resetProjectPicker = () => useProjectPickerStore.setState(initial);
