// The files every package's app.asar must carry, for verify-package.mjs: the package's main, the
// bundles the app runs, and the files they read from beside themselves.
export const ASAR_ENTRIES = [
  "package.json",
  // The package's main: the app, or a file the app ships (gram-host, the native probe).
  "out/main/entry.js",
  "out/main/index.js",
  "out/server/server.js",
  "out/server/proc-worker.js",
  // This machine's worker host, when it runs as its own process.
  "out/server/gram-host.js",
  // The release checks' native probe, the one script besides gram-host the binary runs.
  "out/server/native-probe.js",
  // The terminal emulator the server replays scrollback through; read from beside the bundle.
  "out/server/ghostty-vt.wasm",
  // The playbooks read_playbook serves; read from beside the bundle.
  "out/server/playbooks/deliver-a-pull-request.md",
  "out/server/playbooks/coordinate-workers-and-wakes.md",
  "out/preload/index.js",
  // Pinned pages' clipboard guard, their only preload.
  "out/page-guard/page-guard.js",
  // A hosted site window's one call, its only preload.
  "out/hosted-site/hosted-site.js",
  "out/speech/speech.js",
];
