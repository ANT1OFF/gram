// The key vault module: the gateway keys a shell keeps, encrypted at rest by the OS through
// Electron's `safeStorage` (the Keychain on macOS, DPAPI on Windows, the desktop's keyring on Linux).
export * from "./vault.ts";
