import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWLISTS } from "./allowlists.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lint = (source, rule = "gram/no-bare-fork") => {
  const dir = mkdtempSync(join(tmpdir(), "gram-fork-rule-"));
  try {
    const file = join(dir, "fixture.ts");
    const config = join(dir, "oxlint.json");
    writeFileSync(file, source);
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [join(root, "tools/oxlint/gram.mjs")],
        rules: { [rule]: "error" },
      }),
    );
    // Standalone lint fixtures must work without Effect or built workspace packages.
    // Bound the direct Node subprocess independently of Vitest's event-loop timeout.
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/oxlint/bin/oxlint"), "--config", config, "--format", "json", file],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    const output = JSON.parse(result.stdout);
    expect(result.status, result.stderr).toBe(output.diagnostics.length ? 1 : 0);
    return output.diagnostics;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The rule codes the repository's own config reports for a probe file placed in `dir`. */
const probeConfig = (dir) => {
  const file = join(root, dir, `.gram-lint-probe-${process.pid}.ts`);
  writeFileSync(file, 'import { realpath } from "node:fs/promises";\nexport const r = realpath;\n');
  try {
    const result = spawnSync(
      process.execPath,
      [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", file],
      { cwd: root, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
    );
    if (result.error) throw result.error;
    return JSON.parse(result.stdout).diagnostics.map((d) => d.code);
  } finally {
    rmSync(file, { force: true });
  }
};

describe("no-bare-fork", () => {
  it.each(["fork", "forkChild", "forkDetach", "forkDaemon", "runFork", "runForkWith"])(
    "rejects Effect.%s, including aliases and computed access",
    (name) => {
      const diagnostics = lint(
        `import * as E from "effect/Effect";\nE.${name}(task);\nE["${name}"](task);`,
      );
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.every((value) => value.message.includes(`Effect.${name}`))).toBe(true);
    },
  );

  it.each([
    'import { Effect } from "effect"; Effect.runFork(task);',
    'import { Runtime as R } from "effect"; R.runFork(runtime)(task);',
    'import * as R from "effect/Runtime"; R["runFork"](runtime)(task);',
    'import { runFork as launch } from "effect/Effect"; launch(task);',
    'import { runFork as launch } from "effect/Runtime"; launch(runtime)(task);',
    'import { runFork as launch } from "effect/Effect"; task.pipe(launch);',
    'import { runForkWith as launch } from "effect/Effect"; task.pipe(launch(context));',
    'import { runFork as launch } from "effect/Runtime"; pipe(runtime, launch);',
    'import * as effect from "effect"; effect.Effect.runFork(task);',
    'import * as effect from "effect"; effect.Runtime.runFork(runtime)(task);',
  ])("rejects imported runners: %s", (source) => {
    expect(lint(source)).toHaveLength(1);
  });

  it("allows scoped forks, managed runtimes and unrelated or shadowed objects", () => {
    expect(
      lint(`
      import * as Effect from "effect/Effect";
      import * as FiberSet from "effect/FiberSet";
      import { forkScoped } from "effect/Effect";
      import { runFork as launch } from "effect/Effect";
      task.pipe(forkScoped);
      Effect.forkScoped(task);
      Effect.forkIn(task, scope);
      FiberSet.makeRuntime();
      const Runtime = { runFork() {} };
      Runtime.runFork();
      function callback(Effect) { Effect.runFork(task); }
      function named(launch) { task.pipe(launch); }
      const object = { launch: 1 };
      object.launch;
      named(object);
      callback(Runtime);
    `),
    ).toEqual([]);
  });

  it("allows an entry point with a reason on the line above", () => {
    expect(
      lint(`import * as Effect from "effect/Effect";
      // oxlint-disable-next-line gram/no-bare-fork -- process entry point
      Effect.runFork(task);
    `),
    ).toEqual([]);
  });
});

describe("no-focused-tests", () => {
  it("refuses .only on cases and suites, plain, @effect/vitest and conditional", () => {
    const found = lint(
      `import { describe, it } from "@effect/vitest";
      it.only("a", () => {});
      test.only("b", () => {});
      describe.only("c", () => {});
      it.effect.only("d", () => effect);
      it.live.only("e", () => effect);
      describe.skipIf(windows).only("f", () => {});
      it.only.each([1])("g %s", () => {});
      it["only"]("h", () => {});
    `,
      "gram/no-focused-tests",
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("leaves other .only and unfocused tests alone", () => {
    expect(
      lint(
        `import { it } from "vitest";
        it("a", () => {});
        it.skip("b", () => {});
        it.effect("c", () => effect);
        const options = { only: true };
        options.only;
        filters.only("x");
      `,
        "gram/no-focused-tests",
      ),
    ).toEqual([]);
  });
});

describe("no-raw-path", () => {
  const rule = "gram/no-raw-path";

  it("refuses a raw realpath, imported or reached through fs", () => {
    const found = lint(
      `import * as fs from "node:fs";
      import { realpath } from "node:fs/promises";
      import { realpathSync as real, promises } from "fs";
      fs.realpathSync.native(a);
      fs.promises.realpath(a);
      promises.realpath(a);
      const { realpathSync: sync } = fs;
      const { realpath: later } = fs.promises;
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("refuses prefix tests standing in for containment", () => {
    const found = lint(
      `rel.startsWith("..");
      rel.startsWith(\`..\${sep}\`);
      path.startsWith(\`\${root}/\`);
      path.startsWith(\`\${root}\${sep}\`);
      path.startsWith(\`\${root}\${nodePath.sep}\`);
      path.startsWith(root + sep);
      path.startsWith(resolve(dir, from) + "/");
      rel.startsWith(".." + sep);
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(found[0].message).toContain("..build");
  });

  it("allows the path module's helpers and unrelated prefixes and members", () => {
    expect(
      lint(
        `import { isInside, realPath } from "@gram/git";
        const probe = { realpath: (p) => p };
        probe.realpath(a);
        isInside(root, path);
        await realPath(a);
        name.startsWith(".");
        url.startsWith(\`\${origin}/api\`);
        line.startsWith(\`\${prefix}:\`);
      `,
        rule,
      ),
    ).toEqual([]);
  });

  it("is on for the server and git packages under the repository's own config, off elsewhere", () => {
    expect(probeConfig("packages/server/src")).toContain("gram(no-raw-path)");
    expect(probeConfig("packages/git/src")).toContain("gram(no-raw-path)");
    expect(probeConfig("packages/shell/src")).not.toContain("gram(no-raw-path)");
  });

  // The allowlist only shrinks: a pending file that no longer breaks the rule must come off it.
  it.each(ALLOWLISTS["no-raw-path"].pending)("still has an unmoved site in %s", (file) => {
    expect(lint(readFileSync(join(root, file), "utf8"), rule).length).toBeGreaterThan(0);
  });
});

describe("no-day-math", () => {
  const rule = "gram/no-day-math";

  it("refuses a day spelled in milliseconds or seconds, and offset-based local days", () => {
    const found = lint(
      `const a = 86_400_000;
      const b = 24 * 60 * 60 * 1000;
      const c = 8 * 24 * 60 * 60_000;
      const d = 24 * 3_600_000;
      const e = 60 * 60 * 24;
      const f = now - days * 864e5;
      const g = date.getTimezoneOffset();
      date.setHours(0, 0, 0, 0);
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("allows hours, minutes and the module's own names", () => {
    expect(
      lint(
        `import { DAY_MS, plusDays } from "./zone-time.ts";
        const a = 60 * 60 * 1000;
        const b = 12 * 60 * 60_000;
        const c = 7 * DAY_MS;
        const d = 1024 * 1024;
        const e = plusDays(today, -1);
        date.setUTCHours(0);
      `,
        rule,
      ),
    ).toEqual([]);
  });

  it.each(ALLOWLISTS["no-day-math"].pending)("still has an unmoved site in %s", (file) => {
    expect(lint(readFileSync(join(root, file), "utf8"), rule).length).toBeGreaterThan(0);
  });
});

describe("no-adhoc-lock", () => {
  const rule = "gram/no-adhoc-lock";

  it("refuses a map of semaphores, made or declared", () => {
    const found = lint(
      `import * as Semaphore from "effect/Semaphore";
      const a = new Map<string, Semaphore.Semaphore>();
      let b: Map<ThreadId, Semaphore.Semaphore> | undefined;
      const c = new Map<string, Semaphore>();
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([2, 3, 4]);
  });

  it("allows a single semaphore, the keyed lock and other maps", () => {
    expect(
      lint(
        `import * as Semaphore from "effect/Semaphore";
        const lock = Semaphore.makeUnsafe(1);
        const locks = makeKeyedLock<ThreadId>();
        const seen = new Map<string, number>();
      `,
        rule,
      ),
    ).toEqual([]);
  });

  it.each(ALLOWLISTS["no-adhoc-lock"].pending)("still has an unmoved site in %s", (file) => {
    expect(lint(readFileSync(join(root, file), "utf8"), rule).length).toBeGreaterThan(0);
  });
});
