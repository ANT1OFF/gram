import { describe, expect, it } from "vitest";

import {
  makefileSuggestions,
  makefileTargets,
  normalizeShortcut,
  packageJsonSuggestions,
  packageManagerOf,
  parseScriptsFile,
  scriptRunState,
  scriptsFileText,
  scriptSuggestions,
  validateScripts,
} from "./project-scripts.ts";

const pkg = (body: object) => JSON.stringify(body);

describe("package.json suggestions", () => {
  it("offers each script as a run command, the common ones first", () => {
    const text = pkg({
      scripts: { storybook: "storybook dev", test: "vitest run", dev: "vite", lint: "oxlint" },
    });
    expect(packageJsonSuggestions(text)).toEqual([
      { name: "dev", command: "npm run dev", source: "package.json" },
      { name: "test", command: "npm run test", source: "package.json" },
      { name: "lint", command: "npm run lint", source: "package.json" },
      { name: "storybook", command: "npm run storybook", source: "package.json" },
    ]);
  });

  it("runs through the package manager the project uses", () => {
    const text = pkg({ scripts: { build: "tsc" } });
    expect(packageJsonSuggestions(text, ["bun.lock"])[0]?.command).toBe("bun run build");
    expect(packageJsonSuggestions(text, ["pnpm-lock.yaml"])[0]?.command).toBe("pnpm run build");
    expect(packageJsonSuggestions(text, ["yarn.lock"])[0]?.command).toBe("yarn run build");
    expect(packageJsonSuggestions(text, ["package-lock.json"])[0]?.command).toBe("npm run build");
    // `packageManager` wins over a stray lockfile.
    expect(
      packageJsonSuggestions(pkg({ packageManager: "pnpm@9.1.0", scripts: { build: "tsc" } }), [
        "yarn.lock",
      ])[0]?.command,
    ).toBe("pnpm run build");
    expect(packageManagerOf({ packageManager: "deno@2" }, [])).toBe("npm");
  });

  it("leaves out lifecycle scripts and hooks that run with another script", () => {
    const text = pkg({
      scripts: {
        postinstall: "node setup.js",
        prepare: "husky",
        pretest: "build",
        test: "vitest",
        posttest: "report",
        prestart: "only a hook name",
      },
    });
    expect(packageJsonSuggestions(text).map((s) => s.name)).toEqual(["test", "prestart"]);
  });

  it("offers nothing for a file that isn't a package manifest with scripts", () => {
    expect(packageJsonSuggestions("not json")).toEqual([]);
    expect(packageJsonSuggestions("[]")).toEqual([]);
    expect(packageJsonSuggestions(pkg({ scripts: ["a"] }))).toEqual([]);
    expect(packageJsonSuggestions(pkg({ name: "x" }))).toEqual([]);
    expect(packageJsonSuggestions(pkg({ scripts: { blank: "", "bad name": "x" } }))).toEqual([]);
  });
});

describe("Makefile targets", () => {
  it("reads the rules someone would run by name", () => {
    const text = [
      "# Build things",
      "SHELL := /bin/bash",
      "VERSION = 1.2",
      "CC ?= cc",
      ".PHONY: all test lint",
      "all: build",
      "build: deps",
      "\tgo build ./...",
      "test lint:",
      "\tgo test ./...",
      "%.o: %.c",
      "$(BIN): main.go",
      "deps::",
      "release: VERSION = 2.0",
      "docs ::= nope",
      "  indented: not a rule",
      "build: again",
    ].join("\n");
    expect(makefileTargets(text)).toEqual(["all", "build", "test", "lint", "deps"]);
  });

  it("offers them as make commands, the common ones first", () => {
    expect(makefileSuggestions("deploy:\n\ntest:\nbuild:\n")).toEqual([
      { name: "build", command: "make build", source: "Makefile" },
      { name: "test", command: "make test", source: "Makefile" },
      { name: "deploy", command: "make deploy", source: "Makefile" },
    ]);
  });

  it("reads a long run of whitespace in linear time", () => {
    // CodeQL js/polynomial-redos: a quote, then many tabs, with no colon after them.
    const hostile = `"${"\t".repeat(50_000)}x`;
    const started = performance.now();
    expect(makefileTargets(`${hostile}\n${hostile}:\ntest:\n`)).toEqual(["x", "test"]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("reads CRLF files", () => {
    expect(makefileTargets("test:\r\n\tgo test\r\nlint:\r\n")).toEqual(["test", "lint"]);
  });
});

describe("scriptSuggestions", () => {
  it("skips what is already saved, by name or by command, and repeats nothing", () => {
    const suggestions = scriptSuggestions(
      {
        packageJson: pkg({ scripts: { test: "vitest", lint: "oxlint", dev: "vite" } }),
        makefile: "test:\nlint:\ndeploy:\n",
        files: ["bun.lock"],
      },
      [
        { name: "Tests", command: "bun run test" },
        { name: "dev", command: "something else" },
      ],
    );
    expect(suggestions).toEqual([
      { name: "lint", command: "bun run lint", source: "package.json" },
      // Another way to test, under a name the saved one doesn't take; make's lint is a repeat.
      { name: "test", command: "make test", source: "Makefile" },
      { name: "deploy", command: "make deploy", source: "Makefile" },
    ]);
  });

  it("offers nothing without either file", () => {
    expect(scriptSuggestions({}, [])).toEqual([]);
  });
});

describe("the scripts file", () => {
  it("reads back what it writes", () => {
    const scripts = [
      { name: "test", command: "bun run test", shortcut: "mod+alt+t" },
      { name: "web dev", command: "bun run dev", cwd: "apps/web" },
    ];
    const text = scriptsFileText(scripts);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "scripts": [\n');
    expect(parseScriptsFile(text)).toEqual({ scripts });
  });

  it("says why a file can't be read", () => {
    expect(parseScriptsFile("{")).toEqual({ error: ".gram/scripts.json isn't valid JSON." });
    expect(parseScriptsFile("{}")).toEqual({ error: '.gram/scripts.json has no "scripts" list.' });
    expect(parseScriptsFile('{"scripts":[{"name":"x"}]}')).toEqual({
      error: '.gram/scripts.json script 1 needs a "name" and a "command".',
    });
    expect(
      parseScriptsFile('{"scripts":[{"name":"x","command":"a"},{"name":"X","command":"b"}]}'),
    ).toEqual({ error: ".gram/scripts.json: X: There is already a script named X." });
  });
});

const bad = (script: { name: string; command: string; cwd?: string; shortcut?: string }) => {
  const result = validateScripts([script]);
  return "error" in result ? result.error : undefined;
};

describe("validateScripts", () => {
  it("tidies blanks away and puts shortcuts in canonical order", () => {
    expect(
      validateScripts([
        { name: " test ", command: " bun test ", cwd: " ", shortcut: "Shift+Mod+T" },
        { name: "root", command: "ls", cwd: "." },
      ]),
    ).toEqual({
      scripts: [
        { name: "test", command: "bun test", shortcut: "mod+shift+t" },
        { name: "root", command: "ls" },
      ],
    });
  });

  it("refuses commands that aren't one line, folders outside the project and clashing keys", () => {
    expect(bad({ name: "a", command: "echo a\necho b" })).toMatch(/one line/);
    expect(bad({ name: "a", command: "  " })).toMatch(/Give the command/);
    expect(bad({ name: "a", command: "x", cwd: "/etc" })).toMatch(/relative/);
    expect(bad({ name: "a", command: "x", cwd: "../other" })).toMatch(/inside the project/);
    expect(bad({ name: "a", command: "x", cwd: "~/code" })).toMatch(/relative/);
    expect(bad({ name: "a/b\u0007", command: "x" })).toMatch(/Name it/);
    expect(
      validateScripts([
        { name: "a", command: "x", shortcut: "mod+alt+t" },
        { name: "b", command: "y", shortcut: "alt+mod+t" },
      ]),
    ).toEqual({ error: "b: a already uses that shortcut." });
  });
});

describe("normalizeShortcut", () => {
  it("needs a modifier that typing doesn't use", () => {
    expect(normalizeShortcut("t")).toHaveProperty("error");
    expect(normalizeShortcut("shift+t")).toHaveProperty("error");
    expect(normalizeShortcut("alt+shift+1")).toEqual({ keys: "alt+shift+1" });
    expect(normalizeShortcut("ctrl+mod+b")).toEqual({ keys: "mod+ctrl+b" });
    expect(normalizeShortcut("f5")).toEqual({ keys: "f5" });
    expect(normalizeShortcut("shift+f12")).toEqual({ keys: "shift+f12" });
    expect(normalizeShortcut("mod+enter")).toHaveProperty("error");
    expect(normalizeShortcut("meta+t")).toHaveProperty("error");
  });
});

describe("scriptRunState", () => {
  it("is finished only for a clean exit", () => {
    expect(scriptRunState({ code: 0 })).toBe("finished");
    expect(scriptRunState({ code: 1 })).toBe("failed");
    expect(scriptRunState({ signal: "SIGTERM" })).toBe("failed");
    expect(scriptRunState({})).toBe("failed");
  });
});
