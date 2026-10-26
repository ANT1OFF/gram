import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createShipIt, type RunTool } from "./native-shipit.ts";

const BUNDLE = "io.github.ant1off.gram";

/** A synthetic launchd: `loaded` is whether the ShipIt job exists; every call is recorded. */
function launchd(loaded: boolean | "broken") {
  const calls: string[] = [];
  let job = loaded;
  const run: RunTool = async (file, args) => {
    calls.push([file, ...args].join(" "));
    if (args[0] === "remove") {
      if (job === true) job = false;
      return { status: 0, out: "" };
    }
    if (job === "broken") return { status: 1, out: "launchctl: something else" };
    return job
      ? { status: 0, out: '{ "Label" = "x"; }' }
      : { status: 113, out: "Could not find service" };
  };
  return { run, calls };
}

function home(withState: boolean) {
  const root = mkdtempSync(join(tmpdir(), "gram-shipit-"));
  const dir = join(root, "Library/Caches", `${BUNDLE}.ShipIt`);
  mkdirSync(dir, { recursive: true });
  if (withState) writeFileSync(join(dir, "ShipItState.plist"), "<plist/>");
  return { root, state: join(dir, "ShipItState.plist") };
}

describe("ShipIt", () => {
  it("has nothing pending without its request or its launchd job", async () => {
    const { run } = launchd(false);
    expect(await createShipIt({ bundleId: BUNDLE, home: home(false).root, run }).pending()).toBe(
      false,
    );
  });

  it("is pending with either its request file or its job", async () => {
    expect(
      await createShipIt({
        bundleId: BUNDLE,
        home: home(true).root,
        run: launchd(false).run,
      }).pending(),
    ).toBe(true);
    expect(
      await createShipIt({
        bundleId: BUNDLE,
        home: home(false).root,
        run: launchd(true).run,
      }).pending(),
    ).toBe(true);
  });

  it("can't tell when launchctl answers something else, which callers treat as pending", async () => {
    const shipIt = createShipIt({
      bundleId: BUNDLE,
      home: home(false).root,
      run: launchd("broken").run,
    });
    expect(await shipIt.pending()).toBeUndefined();
    expect(await shipIt.disarm()).toBe(false);
  });

  it("disarms by removing the job and the request, and says so only once both are gone", async () => {
    const { root, state } = home(true);
    const { run, calls } = launchd(true);
    const shipIt = createShipIt({ bundleId: BUNDLE, home: root, run });
    expect(await shipIt.disarm()).toBe(true);
    expect(existsSync(state)).toBe(false);
    expect(calls).toContain(`/bin/launchctl remove ${BUNDLE}.ShipIt`);
    expect(await shipIt.pending()).toBe(false);
  });
});
