// The key vault module: the gateway keys a shell keeps, encrypted at rest by the OS. On macOS an
// internally signed build reads its Safe Storage key through Apple's `security` CLI, so an update
// doesn't ask for keychain access again; elsewhere, and
// with an Apple Team ID, Electron's `safeStorage`.
export * from "./mac.ts";
export * from "./vault.ts";
