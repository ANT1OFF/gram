// How Gram's own app is started to run gram-host. A packaged app has Electron's RunAsNode fuse off,
// so its binary is never a Node that runs whatever script it is handed. Its own entry
// (`apps/desktop/src/main/entry.ts`) runs the gram-host bundled in its app.asar when that bundle's
// path is its first argument, as every release has started it, or `--gram-host` is, and nothing
// else: host mode. The host then runs in Electron's main process (`launch.ts`).
//
// The launchers keep setting `ELECTRON_RUN_AS_NODE=1`. A packaged app with the fuse off ignores
// it, and an Electron run from source (which keeps the fuse) or a release from before host mode
// still runs the host as plain Node with it. gram-host runs either way. Nothing here imports more
// than this, so the app's entry can read it before anything else loads.

/** The argument that runs the app's own gram-host where its path isn't stable (an AppImage). */
export const HOST_MODE_FLAG = "--gram-host";

/**
 * Chromium's switches a Linux host needs from its first instant, before any of its code runs: no
 * display (a joined server has none, and Chromium would otherwise exit looking for one), and no
 * renderer sandbox, which needs user namespaces a server may not allow and guards web content the
 * host never loads. Electron reads them anywhere on the command line, so they go last.
 */
export const LINUX_HOST_SWITCHES: ReadonlyArray<string> = [
  "--ozone-platform=headless",
  "--no-sandbox",
];

/** The switches a launch of the app needs: on Linux, when its binary is Electron's. */
export const hostSwitches = (
  platform: NodeJS.Platform = process.platform,
  electron: boolean = process.versions["electron"] !== undefined,
): ReadonlyArray<string> => (electron && platform === "linux" ? LINUX_HOST_SWITCHES : []);

/** `argv` without the switches, which are Chromium's and never gram-host's own arguments. */
export const withoutHostSwitches = (argv: ReadonlyArray<string>): string[] =>
  argv.filter((arg) => !LINUX_HOST_SWITCHES.includes(arg));
