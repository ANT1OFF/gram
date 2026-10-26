// The shell's Electron wiring: windows, their manager over real displays, and
// what they share. It imports `electron`, so only a main process loads it; the logic it wires is
// in `/core`, tested with fakes.
export * from "./links.ts";
export * from "./menu.ts";
export * from "./watch-window.ts";
export * from "./window-host.ts";
export * from "./windows.ts";
