import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  readProjectScripts,
  resolveScriptRun,
  saveProjectScripts,
  scriptShellArgs,
  ScriptsError,
} from "./project-scripts.ts";

const PROJECT = "p-scripts" as ProjectId;

const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "gram-scripts-")));

/** A project with a `package.json` run by bun and a Makefile. */
const project = () => {
  const root = folder();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest", dev: "vite", postinstall: "x" } }),
  );
  writeFileSync(join(root, "bun.lock"), "{}");
  writeFileSync(join(root, "Makefile"), ".PHONY: deploy\ndeploy:\n\t./deploy.sh\n");
  return root;
};

describe("project scripts", () => {
  it("offers package.json's scripts and the Makefile's targets before anything is saved", async () => {
    const root = project();
    expect(await readProjectScripts(root, PROJECT)).toEqual({
      projectId: PROJECT,
      file: ".gram/scripts.json",
      scripts: [],
      suggestions: [
        { name: "dev", command: "bun run dev", source: "package.json" },
        { name: "test", command: "bun run test", source: "package.json" },
        { name: "deploy", command: "make deploy", source: "Makefile" },
      ],
    });
  });

  it("saves a file a person can edit, and stops suggesting what it holds", async () => {
    const root = project();
    const saved = await saveProjectScripts(root, PROJECT, [
      { name: "test", command: "bun run test", shortcut: "Alt+Mod+T" },
    ]);
    expect(saved.scripts).toEqual([
      { name: "test", command: "bun run test", shortcut: "mod+alt+t" },
    ]);
    expect(saved.suggestions.map((s) => s.name)).toEqual(["dev", "deploy"]);
    expect(readFileSync(join(root, ".gram", "scripts.json"), "utf8")).toBe(
      '{\n  "scripts": [\n    {\n      "name": "test",\n      "command": "bun run test",\n      "shortcut": "mod+alt+t"\n    }\n  ]\n}\n',
    );
  });

  it("refuses scripts it couldn't read back", async () => {
    const root = project();
    await expect(
      saveProjectScripts(root, PROJECT, [{ name: "a", command: "echo 1\necho 2" }]),
    ).rejects.toBeInstanceOf(ScriptsError);
  });

  it("reports a file it can't read, and saving replaces it", async () => {
    const root = folder();
    mkdirSync(join(root, ".gram"));
    writeFileSync(join(root, ".gram", "scripts.json"), "{ nope");
    const read = await readProjectScripts(root, PROJECT);
    expect(read.problem).toBe(".gram/scripts.json isn't valid JSON.");
    expect(read.scripts).toEqual([]);
    const saved = await saveProjectScripts(root, PROJECT, [{ name: "ls", command: "ls" }]);
    expect(saved).not.toHaveProperty("problem");
  });

  it("won't write through a .gram link that leads out of the project", async () => {
    const root = folder();
    const elsewhere = folder();
    symlinkSync(elsewhere, join(root, ".gram"));
    await expect(
      saveProjectScripts(root, PROJECT, [{ name: "ls", command: "ls" }]),
    ).rejects.toThrow(/outside the project/);
  });

  it("runs a script from the project's file in the thread's checkout", async () => {
    const root = project();
    const worktree = folder();
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    await saveProjectScripts(root, PROJECT, [
      { name: "web", command: "bun run dev", cwd: "apps/web" },
      { name: "out", command: "ls", cwd: "apps/../../" },
    ]).catch(() => undefined);
    await saveProjectScripts(root, PROJECT, [
      { name: "web", command: "bun run dev", cwd: "apps/web" },
    ]);
    expect(await resolveScriptRun(root, worktree, "web")).toEqual({
      name: "web",
      command: "bun run dev",
      cwd: join(worktree, "apps", "web"),
    });
    await expect(resolveScriptRun(root, worktree, "nope")).rejects.toThrow(/no script named nope/);
    await expect(resolveScriptRun(folder(), worktree, "web")).rejects.toThrow(/has no/);
  });

  it("refuses a folder that a link leads out of the checkout", async () => {
    const root = project();
    const worktree = folder();
    symlinkSync(folder(), join(worktree, "away"));
    await saveProjectScripts(root, PROJECT, [{ name: "away", command: "ls", cwd: "away" }]);
    await expect(resolveScriptRun(root, worktree, "away")).rejects.toThrow(/outside the checkout/);
  });
});

describe("scriptShellArgs", () => {
  it("runs the line once in each kind of shell", () => {
    expect(scriptShellArgs({ file: "/bin/zsh", args: ["-l"] }, "make test", "darwin")).toEqual([
      "-l",
      "-c",
      "make test",
    ]);
    expect(scriptShellArgs({ file: "powershell.exe", args: [] }, "npm test", "win32")).toEqual([
      "-NoLogo",
      "-Command",
      "npm test",
    ]);
    expect(
      scriptShellArgs({ file: "C:\\Windows\\cmd.exe", args: [] }, "npm test", "win32"),
    ).toEqual(["/d", "/s", "/c", "npm test"]);
    expect(
      scriptShellArgs(
        { file: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["--login", "-i"] },
        "make",
        "win32",
      ),
    ).toEqual(["--login", "-c", "make"]);
  });
});
