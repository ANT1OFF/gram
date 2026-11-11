// A personal device's core, for the desktop app's main process: its key and what it signs, the
// folders it may lend and how it reads from them, and the environment its commands run with.
// The design is `docs/design/personal-device.md`.
export * from "./environment.ts";
export * from "./folders.ts";
export * from "./keys.ts";
