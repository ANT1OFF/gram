import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CUSTOMIZATIONS_REFUSAL, refuseCustomizations } from "./workspace.ts";

const made: Array<string> = [];

/** A fresh folder outside any repository, removed after the test. */
const scratch = () => {
  const at = realpathSync(mkdtempSync(join(tmpdir(), "gram-agy-ws-")));
  made.push(at);
  return at;
};

const hooksIn = (dir: string) => {
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", "hooks.json"), "{}");
};

afterEach(() => {
  for (const at of made.splice(0)) rmSync(at, { recursive: true, force: true });
});

describe("a work folder's own Antigravity customizations", () => {
  it("refuses a linked work folder whose real repository has them", () => {
    const at = scratch();
    const repo = join(at, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "sub"));
    hooksIn(repo);
    symlinkSync(join(repo, "sub"), join(at, "lnk"));
    expect(refuseCustomizations([join(at, "lnk")])).toContain(CUSTOMIZATIONS_REFUSAL);
  });

  it("refuses a folder reached through a linked folder below the repository's root", () => {
    const at = scratch();
    const repo = join(at, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "pkgs", "app"), { recursive: true });
    hooksIn(repo);
    mkdirSync(join(at, "elsewhere"));
    symlinkSync(join(repo, "pkgs"), join(at, "elsewhere", "pkgs"));
    expect(refuseCustomizations([join(at, "elsewhere", "pkgs", "app")])).toContain(
      CUSTOMIZATIONS_REFUSAL,
    );
  });

  it("refuses an extra folder that is a link into a repository that has them", () => {
    const at = scratch();
    const repo = join(at, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "docs"));
    mkdirSync(join(at, "work"));
    hooksIn(repo);
    symlinkSync(join(repo, "docs"), join(at, "docs"));
    expect(refuseCustomizations([join(at, "work"), join(at, "docs")])).toContain(
      CUSTOMIZATIONS_REFUSAL,
    );
  });

  it("outside a repository, looks in the folder itself and no parent", () => {
    const at = scratch();
    const work = join(at, "work");
    mkdirSync(work);
    hooksIn(at);
    expect(refuseCustomizations([work])).toBeUndefined();
    hooksIn(work);
    expect(refuseCustomizations([work])).toContain(CUSTOMIZATIONS_REFUSAL);
  });
});
