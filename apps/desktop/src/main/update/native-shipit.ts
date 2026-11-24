import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "@gram/contracts";

export type RunTool = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly status: number | null; readonly out: string }>;

const runTool: RunTool = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: 15_000, maxBuffer: 1024 ** 2, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
      (error, stdout, stderr) =>
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : null) : 0,
          out: `${stdout}\n${stderr}`,
        }),
    );
  });

const NO_SUCH_JOB = 113;

export interface ShipIt {
  /** Where its request and log live, for messages. */
  readonly dir: string;
  /**
   * Whether an install is pending: its request file or its launchd job exists. Undefined when
   * that can't be told, which callers treat as pending.
   */
  pending(): Promise<boolean | undefined>;
  /** Removes its launchd job and request; true only once neither is left. */
  disarm(): Promise<boolean>;
}

export function createShipIt(options: {
  readonly bundleId: string;
  readonly home: string;
  readonly run?: RunTool;
}): ShipIt {
  const label = `${options.bundleId}.ShipIt`;
  const dir = join(options.home, "Library/Caches", label);
  const state = join(dir, "ShipItState.plist");
  const run = options.run ?? runTool;
  const stateExists = async (): Promise<boolean | undefined> => {
    try {
      await lstat(state);
      return true;
    } catch (error) {
      return errnoCode(error) === "ENOENT" ? false : undefined;
    }
  };
  const jobLoaded = async (): Promise<boolean | undefined> => {
    const listed = await run("/bin/launchctl", ["list", label]);
    if (listed.status === 0) return true;
    return listed.status === NO_SUCH_JOB || /Could not find service/i.test(listed.out)
      ? false
      : undefined;
  };
  const pending = async () => {
    const [file, job] = await Promise.all([stateExists(), jobLoaded()]);
    if (file === true || job === true) return true;
    return file === false && job === false ? false : undefined;
  };
  return {
    dir,
    pending,
    async disarm() {
      await run("/bin/launchctl", ["remove", label]);
      await rm(state, { force: true }).catch(() => {});
      return (await pending()) === false;
    },
  };
}
