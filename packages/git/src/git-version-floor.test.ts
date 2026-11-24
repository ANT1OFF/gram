import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { gh, git } from "./exec.ts";
import { ProcLive } from "./proc.ts";
import { removeDir, tempDir } from "./test-utils.ts";

/**
 * A folder holding a `git` that reports `version` and a `gh`, each logging the arguments it was
 * started with, and the process's PATH pointed at it. `Proc` takes PATH from a login shell, so
 * `SHELL` names one that can't start, and the process's own PATH is used.
 */
const fakeTools = (root: string, version: string) => {
  const bin = nodePath.join(root, "bin");
  const log = nodePath.join(root, "log");
  fs.mkdirSync(bin);
  for (const name of ["git", "gh"])
    fs.writeFileSync(
      nodePath.join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> '${log}'\n` +
        (name === "git" ? `[ "$1" = "--version" ] && echo '${version}'\n` : "") +
        "exit 0\n",
      { mode: 0o755 },
    );
  process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  process.env["SHELL"] = nodePath.join(root, "no-shell");
  return {
    ran: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []),
  };
};

describe.skipIf(process.platform === "win32")("git older than 2.31 under Proc", () => {
  const dirs: Array<string> = [];
  const saved = { PATH: process.env["PATH"], SHELL: process.env["SHELL"] };
  afterEach(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const dir of dirs.splice(0)) removeDir(dir);
  });
  const root = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };

  it.effect("refuses git and gh with the upgrade message, running nothing but --version", () =>
    Effect.gen(function* () {
      const dir = root();
      const tools = fakeTools(dir, "git version 2.30.2");
      for (const started of [git(dir, ["status"]), gh(dir, ["pr", "view", "1"])]) {
        const refused = yield* Effect.flip(started.pipe(Effect.provide(ProcLive)));
        expect(refused.message).toMatch(/Install Git 2\.31 or newer/);
      }
      expect(tools.ran().length).toBeGreaterThan(0);
      expect(tools.ran().every((line) => line === "git --version")).toBe(true);
    }),
  );

  it.effect("runs git and gh from 2.31", () =>
    Effect.gen(function* () {
      const dir = root();
      const tools = fakeTools(dir, "git version 2.31.0");
      yield* gh(dir, ["pr", "view", "1"]).pipe(Effect.provide(ProcLive));
      expect(tools.ran()).toContain("gh pr view 1");
    }),
  );
});
