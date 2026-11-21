import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

import { LINUX_HOST_SWITCHES } from "@gram/server/host/launch-args";
import { shippedTarget } from "./shipped-target.ts";

const shipped = (name: string) => join(app.getAppPath(), "out", "server", name);

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
  require(join(__dirname, "index.js"));
} else {
  if (
    process.platform === "linux" &&
    !LINUX_HOST_SWITCHES.every((switchName) => process.argv.includes(switchName))
  )
    relaunchWithSwitches();
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  process.argv = [process.execPath, target, ...process.argv.slice(2)];
  require(target);
}
