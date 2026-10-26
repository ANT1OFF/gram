import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFromFile } from "electron-vite";
import { afterEach, expect, it } from "vitest";

import { captureBuildSource } from "./build-source.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it("captures only clean committed source, refusing modified/untracked/archive builds", () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-provenance-test-"));
  dirs.push(dir);
  expect(captureBuildSource(dir)).toBeNull();
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init");
  writeFileSync(join(dir, "source.ts"), "export const version = 1;\n");
  git("add", "source.ts");
  git(
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic source",
  );
  expect(captureBuildSource(dir)).toBe(git("rev-parse", "HEAD"));
  writeFileSync(join(dir, "source.ts"), "export const version = 2;\n");
  expect(captureBuildSource(dir)).toBeNull();
  git("checkout", "--", "source.ts");
  writeFileSync(join(dir, "untracked.ts"), "export const pending = true;\n");
  expect(captureBuildSource(dir)).toBeNull();
});

it("captures clean source through the real config loader after its temporary file is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-config-provenance-test-"));
  dirs.push(dir);
  const desktop = join(dir, "apps/desktop");
  mkdirSync(join(desktop, "src"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  symlinkSync(
    fileURLToPath(new URL("../../../node_modules", import.meta.url)),
    join(dir, "node_modules"),
  );
  writeFileSync(
    join(desktop, "electron.vite.config.ts"),
    readFileSync(fileURLToPath(new URL("../electron.vite.config.ts", import.meta.url))),
  );
  writeFileSync(
    join(desktop, "src/build-source.ts"),
    readFileSync(fileURLToPath(new URL("./build-source.ts", import.meta.url))),
  );
  // The shipped bundles' minify settings, which it imports beside it.
  writeFileSync(
    join(desktop, "shipped-code.ts"),
    readFileSync(fileURLToPath(new URL("../shipped-code.ts", import.meta.url))),
  );
  // The config's notices plugin (tools/notices), which it imports by relative path.
  mkdirSync(join(dir, "tools/notices"), { recursive: true });
  writeFileSync(
    join(dir, "tools/notices/bundled-packages.mjs"),
    readFileSync(
      fileURLToPath(new URL("../../../tools/notices/bundled-packages.mjs", import.meta.url)),
    ),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic build configuration",
  );
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    join(desktop, "electron.vite.config.ts"),
    desktop,
    "silent",
  );
  expect(loaded?.config.main?.define?.["GRAM_BUILD_SOURCE"]).toBe(
    JSON.stringify(git("rev-parse", "HEAD")),
  );
  expect(git("status", "--porcelain")).toBe("");
});

it("refuses an ignored Git-free nested archive but accepts canonical roots and linked worktrees", () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-nested-provenance-test-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init");
  writeFileSync(join(dir, ".gitignore"), "release/\n");
  writeFileSync(join(dir, "source.ts"), "export const source = 'parent';\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic parent source",
  );
  const source = git("rev-parse", "HEAD");
  const archive = join(dir, "release/archive");
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, "source.ts"), "export const source = 'different archive';\n");
  expect(git("status", "--porcelain")).toBe("");
  expect(captureBuildSource(archive)).toBeNull();
  const alias = join(dir, "release/source-alias");
  symlinkSync(dir, alias);
  expect(captureBuildSource(alias)).toBe(source);
  const linked = join(dir, "release/linked-worktree");
  git("worktree", "add", "--detach", linked);
  expect(captureBuildSource(linked)).toBe(source);
});
