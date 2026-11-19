// The app's first code, before anything that opens a window or touches the app's profile. A
// packaged Gram has Electron's RunAsNode fuse off, so its binary never runs a script it is handed.
// What it runs instead, besides the app, is code it ships in its own app.asar: its gram-host
// (host mode, `packages/server/src/host/launch-args.ts`), and for release checks its native probe.
// It runs one when started with that file's own path as its first argument, which is how every
// release has started gram-host, or with `--gram-host`. Any other first argument is the app's.

import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

import { LINUX_HOST_SWITCHES } from "@gram/server/host/launch-args";
import { shippedTarget } from "./shipped-target.ts";

const shipped = (name: string) => join(app.getAppPath(), "out", "server", name);

/**
 * On Linux, Chromium needs its switches on the command line itself: with no display and without
 * them it exits once this code returns. A launch an earlier release wrote (a shim, a service, a
 * supervisor) has none, so it is run again with them and this process waits for it, passing on
 * its descriptors (the host's stream is the fourth) and its end.
 */
const relaunchWithSwitches = (): never => {
  const fourth = (() => {
    try {
      fstatSync(3);
      return 3;
    } catch {
      return "ignore" as const;
    }
  })();
  const missing = LINUX_HOST_SWITCHES.filter((switchName) => !process.argv.includes(switchName));
  const done = spawnSync(process.execPath, [...process.argv.slice(1), ...missing], {
    stdio: ["inherit", "inherit", "inherit", fourth],
  });
  if (done.signal !== null) process.kill(process.pid, done.signal);
  process.exit(done.status ?? 1);
};

const target = shippedTarget(process.argv[1], shipped("gram-host.js"), shipped("native-probe.js"));
if (target === undefined) {
  // Its path built, so the bundler leaves it: the app loads only once nothing else is asked for.
  require(join(__dirname, "index.js"));
} else {
  if (
    process.platform === "linux" &&
    !LINUX_HOST_SWITCHES.every((switchName) => process.argv.includes(switchName))
  )
    relaunchWithSwitches();
  // Neither draws anything.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  // The shipped file's own path where its argument was, as `node <file> …` would have it.
  process.argv = [process.execPath, target, ...process.argv.slice(2)];
  require(target);
}
