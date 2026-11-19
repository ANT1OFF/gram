// gram-host's own process, as Node or in host mode in Electron's main process (`launch-args.ts`).

import { createRequire } from "node:module";
import { join } from "node:path";
import * as Runtime from "effect/Runtime";
import type { app as ElectronApp } from "electron";
import { withoutHostSwitches } from "./launch-args.ts";

export { HOST_MODE_FLAG, hostSwitches, LINUX_HOST_SWITCHES } from "./launch-args.ts";

/** Whether this is Electron's main process (host mode) rather than Node. */
const inElectronMain = () => (process as { type?: string }).type === "browser";

/**
 * Readies the process to be gram-host. Under Node that is only its arguments. In Electron's main
 * process it also takes away what a process with windows has: the GPU, a Dock icon on a Mac, the
 * app's own profile (the host gets a folder of its own inside it, so it never shares the running
 * app's), and Electron's dialog for an uncaught error, which here ends the process as Node would.
 */
export const prepareHostProcess = (): void => {
  process.argv = withoutHostSwitches(process.argv);
  if (!inElectronMain()) return;
  // Loaded only here, so the bundle leaves Electron's own module to Electron.
  const { app } = createRequire(import.meta.url)("electron") as { app: typeof ElectronApp };
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", join(app.getPath("userData"), "gram-host"));
  app.dock?.hide();
  process.on("uncaughtException", (error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
};

/**
 * The host's teardown. Node ends once nothing is left to do; Electron's main process never ends by
 * itself, so there it ends with the code, once what it wrote has gone out.
 */
export const hostTeardown: Runtime.Teardown = (exit, onExit) =>
  Runtime.defaultTeardown(exit, (code) => {
    if (!inElectronMain()) return onExit(code);
    process.exitCode = code;
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
