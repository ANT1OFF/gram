import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { personalMacTargets, writableMacTarget } from "./mac-target.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/** A synthetic `Gram.app` owned by this user, in a fresh parent directory. */
async function bundle() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "gram-target-test-")));
  dirs.push(parent);
  const app = join(parent, "Gram.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(join(app, "Contents/Info.plist"), "<plist/>");
  await writeFile(join(app, "Contents/MacOS/Gram"), "synthetic");
  return { parent, app };
}

describe.skipIf(process.platform === "win32")("writableMacTarget", () => {
  it("names only the two personal Applications folders", () => {
    expect(personalMacTargets()).toHaveLength(2);
    expect(personalMacTargets()[0]).toBe("/Applications/Gram.app");
    expect(personalMacTargets()[1]).toMatch(/\/Applications\/Gram\.app$/);
  });

  it("accepts an owned, canonical bundle in a writable parent it is allowed to replace", async () => {
    const { app } = await bundle();
    expect(await writableMacTarget(app, [app])).toBe(true);
  });

  it("refuses a location outside the allowed targets", async () => {
    const { app } = await bundle();
    expect(await writableMacTarget(app, ["/Applications/Gram.app"])).toBe(false);
  });

  it("refuses a symlinked bundle, a world-writable parent and a missing executable", async () => {
    const { parent, app } = await bundle();
    const link = join(parent, "Linked.app");
    await symlink(app, link);
    expect(await writableMacTarget(link, [link])).toBe(false);

    await chmod(parent, 0o777);
    expect(await writableMacTarget(app, [app])).toBe(false);
    await chmod(parent, 0o700);

    await rm(join(app, "Contents/MacOS/Gram"));
    expect(await writableMacTarget(app, [app])).toBe(false);
  });
});
