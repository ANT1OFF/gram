// The shell's Electron-free logic, which the desktop app wires up.
// Nothing here imports `electron`: the app passes its Electron pieces in, so every
// module is tested with fakes. Main-process only; a preload imports `/channels` or `/window-arg`.
export * from "./browse-rules.ts";
export * from "./instance.ts";
export * from "./link-gate.ts";
export * from "./log.ts";
export * from "./notification-status.ts";
export * from "./page-driver.ts";
export * from "./preview-rules.ts";
export * from "./product.ts";
export * from "./renderer-health.ts";
export * from "./rules.ts";
export * from "./tray-menu.ts";
export * from "./tray-mode.ts";
export * from "./window-manager.ts";
