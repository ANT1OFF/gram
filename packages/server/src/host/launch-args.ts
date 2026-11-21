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
