import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWLISTS, MAX_LINES } from "./allowlists.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Lints each source as a file of its own in one oxlint run, and returns each file's diagnostics. */
const lintEach = (
  sources,
  rule = "gram/no-bare-fork",
  extension = ".ts",
  setting = "error",
  names,
) => {
  const dir = mkdtempSync(join(tmpdir(), "gram-fork-rule-"));
  try {
    const files = sources.map((source, i) => {
      const file = join(dir, names?.[i] ?? `fixture-${i}${extension}`);
      writeFileSync(file, source);
      return file;
    });
    const config = join(dir, "oxlint.json");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [join(root, "tools/oxlint/gram.mjs")],
        rules: { [rule]: setting },
      }),
    );
    // Standalone lint fixtures must work without Effect or built workspace packages.
    // Bound the direct Node subprocess independently of Vitest's event-loop timeout.
    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/oxlint/bin/oxlint"),
        "--config",
        config,
        "--format",
        "json",
        ...files,
      ],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    const output = JSON.parse(result.stdout);
    expect(result.status, result.stderr).toBe(output.diagnostics.length ? 1 : 0);
    return files.map((file) =>
      output.diagnostics.filter((d) => resolve(dir, d.filename) === file || d.filename === file),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const lint = (source, rule, extension) => lintEach([source], rule, extension)[0];

/** The rule codes the repository's own config reports for a probe file placed in `dir`. */
const probeConfig = (
  dir,
  source = 'import { realpath } from "node:fs/promises";\nexport const r = realpath;\n',
) => {
  const file = join(root, dir, `.gram-lint-probe-${process.pid}.ts`);
  writeFileSync(file, source);
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
  it("rejects every bare fork and runner, including aliases and computed access", () => {
    const names = ["fork", "forkChild", "forkDetach", "forkDaemon", "runFork", "runForkWith"];
    const direct = lintEach(
      names.map(
        (name) => `import * as E from "effect/Effect";\nE.${name}(task);\nE["${name}"](task);`,
      ),
    );
    names.forEach((name, i) => {
      expect(direct[i], name).toHaveLength(2);
      expect(
        direct[i].every((value) => value.message.includes(`Effect.${name}`)),
        name,
      ).toBe(true);
    });
    const imported = [
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
    ];
    lintEach(imported).forEach((diagnostics, i) =>
      expect(diagnostics, imported[i]).toHaveLength(1),
    );
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

describe("no-sleep", () => {
  const rule = "gram/no-sleep";

  it("refuses waitForTimeout and every spelling of a promise that is only a timer", () => {
    const found = lint(
      `await page.waitForTimeout(500);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((r) => { setTimeout(r, 20); });
      const sleep = (ms) => new Promise(function (done) { return setTimeout(done, ms); });
      await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve("late"), 9))]);
      await new Promise((resolve) => window.setTimeout(resolve, 5));
      await new Promise<void>((resolve) => globalThis.setTimeout(() => { resolve(); }, 5));
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("says what to wait on instead, in tests and in product code", () => {
    const sleep = "await new Promise((resolve) => setTimeout(resolve, 20));";
    const [inTest, inProduct] = [".test.ts", ".ts"].map((extension) =>
      lint(sleep, rule, extension),
    );
    expect(inTest[0].message).toContain("vi.useFakeTimers()");
    expect(inProduct[0].message).toContain("node:timers/promises");
    expect(lint("await page.waitForTimeout(5);", rule)[0].message).toContain("expect.poll");
  });

  it("allows bounded waits that keep their timer, waits on events and the shared helpers", () => {
    expect(
      lint(
        `import { setTimeout as sleep } from "node:timers/promises";
        await sleep(20);
        let timer;
        await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, 9); })]);
        clearTimeout(timer);
        await new Promise((resolve) => {
          child.once("exit", resolve);
          setTimeout(resolve, 1_000);
        });
        await new Promise((resolve) => setTimeout(() => console.log("x"), 5));
        await new Promise((resolve) => setImmediate(resolve));
        await expect(locator).toBeVisible();
      `,
        rule,
      ),
    ).toEqual([]);
  });

  it("is on everywhere under the repository's own config", () => {
    const file = join(root, "apps/web/src", `.gram-sleep-probe-${process.pid}.ts`);
    writeFileSync(file, "export const s = new Promise((r) => setTimeout(r, 1));\n");
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", file],
        { cwd: root, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
      );
      if (result.error) throw result.error;
      expect(JSON.parse(result.stdout).diagnostics.map((d) => d.code)).toContain("gram(no-sleep)");
    } finally {
      rmSync(file, { force: true });
    }
  });

  // The allowance only shrinks: a file that has lost a sleep must lower its count in the same change.
  // One oxlint run per extension, so the parser is the file's own.
  const pending = Object.entries(ALLOWLISTS["no-sleep"].pending);
  const found = new Map();
  for (const extension of new Set(pending.map(([file]) => extname(file)))) {
    const files = pending.map(([file]) => file).filter((file) => extname(file) === extension);
    const diagnostics = lintEach(
      files.map((file) => readFileSync(join(root, file), "utf8")),
      rule,
      extension,
    );
    files.forEach((file, i) => found.set(file, diagnostics[i].length));
  }
  it.each(pending)("%s keeps exactly the %i sleeps it is allowed", (file, count) => {
    expect(found.get(file), `lower ${file}'s count in tools/oxlint/allowlists.mjs`).toBe(count);
  });
});

describe("no-raw-effect", () => {
  const rule = "gram/no-raw-effect";

  it("refuses React's effects however they are imported", () => {
    const found = lint(
      `import React, { useEffect, useLayoutEffect as before } from "react";
      import * as R from "react";
      export function A() {
        useEffect(() => {}, []);
        before(() => {});
        React.useEffect(() => {});
        R.useLayoutEffect(() => {}, []);
        R.useInsertionEffect(() => {});
      }
    `,
      rule,
      ".tsx",
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([4, 5, 6, 7, 8]);
  });

  it("names the hook that fits what the effect does", () => {
    const [subscribes, timer, mount, latest] = lintEach(
      [
        "useEffect(() => store.subscribe(read), [store]);",
        "useEffect(() => { const t = setTimeout(go, 9); return () => clearTimeout(t); }, []);",
        "useEffect(() => { focus(); }, []);",
        "useEffect(() => { latest.current = value; });",
      ].map((body) => `import { useEffect } from "react";\nexport function A() { ${body} }`),
      rule,
      ".tsx",
    ).map(([diagnostic]) => diagnostic.message);
    expect(subscribes).toContain("useSubscription(");
    expect(timer).toContain("@/lib/timers");
    expect(mount).toContain("useMountEffect(fn)");
    expect(latest).toContain("useLatest(value)");
    expect(subscribes).toContain("CONTRIBUTING.md#react-effects");
  });

  it("allows the named effects, another module's useEffect, and tests", () => {
    const source = `import { useEffect } from "./my-effects";
      import { useSubscription, useMountEffect } from "@/lib/effects";
      export function A() {
        useEffect(() => {});
        useSubscription(() => store.subscribe(read), [store]);
        useMountEffect(() => {});
      }
    `;
    const raw = `import { useEffect } from "react";\nuseEffect(() => {});\n`;
    const found = lintEach([source, raw], rule, ".tsx", "error", ["a.tsx", "a.test.tsx"]);
    expect(found).toEqual([[], []]);
  });

  it("refuses a state update as a named effect runs, not one in its callbacks", () => {
    const found = lint(
      `import { useState } from "react";
      import { useExternalSync, useSubscription } from "@/lib/effects";
      export function A({ value }) {
        const [shown, setShown] = useState(false);
        const [, dispatch] = React.useReducer(reduce, 0);
        useExternalSync(() => {
          if (value) setShown(true);
          dispatch(1);
          useStore.setState({ value });
        }, [value]);
        useSubscription(() => store.subscribe(() => setShown(true)), []);
        return shown;
      }
    `,
      rule,
      ".tsx",
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([7, 8]);
    expect(found[0].message).toContain("Compute the value in render");
  });

  it("is on under the repository's own config, with the named effects' dependencies checked", () => {
    const file = join(root, "apps/web/src", `.gram-effect-probe-${process.pid}.tsx`);
    writeFileSync(
      file,
      `import { useEffect } from "react";
import { useSubscription } from "@/lib/effects";
export function Probe({ store }: { store: { subscribe: () => () => void } }) {
  useEffect(() => {});
  useSubscription(() => store.subscribe(), []);
  return null;
}
`,
    );
    try {
      const result = spawnSync(
        process.execPath,
        [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", file],
        { cwd: root, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
      );
      if (result.error) throw result.error;
      const codes = JSON.parse(result.stdout).diagnostics.map((d) => d.code);
      expect(codes).toContain("gram(no-raw-effect)");
      expect(codes.some((code) => /exhaustive-deps/.test(code))).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  // The allowance only shrinks: a file that has lost a raw effect lowers its count in the same change.
  const pending = Object.entries(ALLOWLISTS["no-raw-effect"].pending);
  const found = new Map();
  for (const extension of new Set(pending.map(([file]) => extname(file)))) {
    const files = pending.map(([file]) => file).filter((file) => extname(file) === extension);
    const diagnostics = lintEach(
      files.map((file) => readFileSync(join(root, file), "utf8")),
      rule,
      extension,
    );
    files.forEach((file, i) => found.set(file, diagnostics[i].length));
  }
  it.each(pending)("%s keeps exactly the %i raw effects it is allowed", (file, count) => {
    expect(found.get(file), `lower ${file}'s count in tools/oxlint/allowlists.mjs`).toBe(count);
  });
});

describe("disable-reason", () => {
  const rule = "gram/disable-reason";

  it("refuses a directive that turns a rule off without saying why", () => {
    const found = lint(
      `// oxlint-disable-next-line no-debugger
      debugger;
      /* eslint-disable no-console */
      const a = 1; // oxlint-disable-line no-unused-vars
      // eslint-disable-next-line no-debugger --
      debugger;
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([1, 3, 4, 5, 7]);
    expect(found[4].message).toContain("react/exhaustive-deps");
  });

  it("allows a directive with its reason, re-enabling, and prose about directives", () => {
    expect(
      lint(
        `// oxlint-disable-next-line no-debugger -- a breakpoint the test needs
        debugger;
        /* eslint-disable no-console -- a CLI's output */
        /* eslint-enable no-console */
        // Directives here say why: see oxlint-disable-next-line in the docs.
        export const a = <div>{/* oxlint-disable-next-line x -- in JSX too */}</div>;
      `,
        rule,
        ".tsx",
      ),
    ).toEqual([]);
  });

  it.each(ALLOWLISTS["disable-reason"].pending)(
    "still has a directive without a reason in %s",
    (file) => {
      expect(
        lint(readFileSync(join(root, file), "utf8"), rule, extname(file)).length,
      ).toBeGreaterThan(0);
    },
  );
});

const codeLines = (n) =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n");

describe("max-lines", () => {
  const rule = "gram/max-lines";
  const small = ["error", { limit: 3, testLimit: 5, pending: {} }];

  it("counts code lines only and holds source and tests to their own limits", () => {
    const padded = `// a comment\n\n${codeLines(2)}\n/*\n * a block\n */\n\nexport const t = 1; // trailing\n`;
    const found = lintEach([padded, codeLines(4), codeLines(5), codeLines(6)], rule, ".ts", small, [
      "padded.ts",
      "over.ts",
      "fits.test.ts",
      "over.spec.ts",
    ]);
    expect(found.map((d) => d.length)).toEqual([0, 1, 0, 1]);
  });

  // The list only shrinks: a listed file may not grow past its count, and one that fits under the
  // limit again comes off the list. One oxlint run counts every listed file.
  const counts = () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-max-lines-"));
    try {
      const config = join(dir, "oxlint.json");
      const setting = ["error", { limit: 0, testLimit: 0, pending: {} }];
      writeFileSync(
        config,
        JSON.stringify({
          categories: { correctness: "off" },
          jsPlugins: [join(root, "tools/oxlint/gram.mjs")],
          rules: { [rule]: setting },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/oxlint/bin/oxlint"),
          "--config",
          config,
          "--format",
          "json",
          ...Object.keys(MAX_LINES.pending),
        ],
        { cwd: root, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 8 << 20 },
      );
      if (result.error) throw result.error;
      return new Map(
        JSON.parse(result.stdout).diagnostics.map((d) => [
          d.filename,
          Number(/has (\d+) lines/.exec(d.message)[1]),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("keeps every listed file over the limit and within its count", () => {
    const lines = counts();
    const wrong = Object.entries(MAX_LINES.pending).flatMap(([file, count]) => {
      const limit = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
        ? MAX_LINES.testLimit
        : MAX_LINES.limit;
      const now = lines.get(file) ?? 0;
      if (now <= limit) return [`${file} fits under ${limit} now (${now}): remove its entry`];
      if (now > count) return [`${file} grew to ${now}, past its entry ${count}: split it`];
      return [];
    });
    expect(wrong, "MAX_LINES.pending in tools/oxlint/allowlists.mjs").toEqual([]);
  });
});

describe("lucide-stroke", () => {
  const rule = "gram/lucide-stroke";

  it("refuses a stroke on a Lucide icon, imported, namespaced or made with createLucideIcon", () => {
    const found = lint(
      `import { Check, createLucideIcon as make } from "lucide-react";
      import * as Icons from "lucide-react";
      const Ring = make({ name: "ring", size: 24, node: [] });
      export const a = <Check strokeWidth={1.5} />;
      export const b = <Icons.X absoluteStrokeWidth />;
      export const c = <Ring className="size-3" strokeWidth={1.5} {...props} />;
    `,
      rule,
      ".tsx",
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([4, 5, 6]);
    expect(found[0].message).toContain("createLucideIcon");
  });

  it("allows a stroke on Gram's own svg, on a node, and other props on an icon", () => {
    expect(
      lint(
        `import { Check, createLucideIcon } from "lucide-react";
        import { Gauge } from "./gauge";
        const Ring = createLucideIcon({
          name: "ring",
          size: 24,
          node: [["circle", { r: "9", strokeWidth: "1.5", key: "ring" }]],
        });
        export const a = <svg strokeWidth={2}><circle strokeWidth="1.5" /></svg>;
        export const b = <Gauge strokeWidth={2} />;
        export const c = <Check className="size-icon-row" />;
        export const d = <Ring />;
        function Local({ Check }) { return <Check strokeWidth={1} />; }
      `,
        rule,
        ".tsx",
      ),
    ).toEqual([]);
  });
});

describe("clock-24h", () => {
  const rule = "gram/clock-24h";

  it("refuses a time of day formatted without a 24-hour cycle", () => {
    const found = lint(
      `new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });
      dateTimeFormat(undefined, { hour: "numeric" });
      new Date(at).toLocaleTimeString();
      new Date(at).toLocaleTimeString("en-US", { minute: "2-digit" });
      new Date(at).toLocaleDateString("en-US", { day: "numeric", hour: "numeric" });
      const OPTIONS = { hour: "2-digit", minute: "2-digit" } as const;
      Intl.DateTimeFormat(undefined, OPTIONS);
      new Intl.DateTimeFormat(undefined, { hour: "numeric", hourCycle: "h12" });
      new Intl.DateTimeFormat(undefined, { hour: "numeric", hour12: true });
      new Intl.DateTimeFormat(undefined, { hour: "numeric", hourCycle: "h24" });
    `,
      rule,
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11]);
    expect(found[0].message).toContain("CLOCK_TIME");
  });

  it("allows a pinned 24-hour cycle, options it can't see, and dates and numbers alone", () => {
    expect(
      lint(
        `import { CLOCK_TIME } from "@/lib/time";
        const LOCAL = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
        new Intl.DateTimeFormat("en-US", { hour: "2-digit", hourCycle: "h23" });
        new Intl.DateTimeFormat("en-US", { timeStyle: "short", hour12: false });
        dateTimeFormat("en-GB", { ...LOCAL, second: "2-digit" });
        dateTimeFormat("en-GB", { ...CLOCK_TIME, ...(zone ? { timeZone: zone } : {}) });
        new Date(at).toLocaleTimeString(undefined, { ...LOCAL });
        new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
        dateTimeFormat("en-GB", { month: "long", year: "numeric" });
        new Intl.DateTimeFormat(locale, options);
        count.toLocaleString("en-US", { maximumFractionDigits: 0 });
        count.toLocaleString();
      `,
        rule,
      ),
    ).toEqual([]);
  });

  it("is on for the web app under the repository's own config", () => {
    const source = "export const t = new Date(0).toLocaleTimeString();\n";
    expect(probeConfig("apps/web/src", source)).toContain("gram(clock-24h)");
    expect(probeConfig("packages/server/src", source)).not.toContain("gram(clock-24h)");
  });
});

// The runtime graph in docs/ARCHITECTURE.md: the renderer and the shared packages load no Node or
// Electron, only the shell imports Electron at runtime, and no package imports an app.
const restricted = (dir, source) =>
  probeConfig(dir, `${source}\nexport const probe = 1;\n`).includes(
    "eslint(no-restricted-imports)",
  );

describe("import boundaries", () => {
  it.each([
    ["apps/web/src", 'import "node:path";'],
    ["apps/web/src", 'import { app } from "electron";'],
    ["apps/web/src", 'import "@gram/server";'],
    ["packages/contracts/src", 'import "node:fs";'],
    ["packages/contracts/src", 'import "@gram/git";'],
    ["packages/server/src", 'import { app } from "electron";'],
    ["packages/server/src", 'import "@gram/shell";'],
    ["packages/git/src", 'import "@gram/server";'],
    ["packages/shell/src", 'import "@gram/web/lib/time";'],
    ["apps/desktop/src/preload", 'import "node:fs";'],
    ["apps/desktop/src/preload", 'import { Channels } from "@gram/shell/core";'],
    ["apps/desktop/src/preload", 'import { createLogger } from "@gram/server/logging";'],
    ["apps/desktop/src/main", 'import "@gram/web";'],
    ["apps/desktop/src/main", 'import "@gram/agents";'],
    ["apps/desktop/src/main", 'import "@gram/server/main";'],
  ])("refuses in %s: %s", (dir, source) => {
    expect(restricted(dir, source)).toBe(true);
  });

  it.each([
    ["apps/web/src", 'import "@gram/contracts";'],
    ["packages/server/src", 'import type { App } from "electron";'],
    ["packages/server/src", 'import "@gram/git";'],
    ["packages/shell/src", 'import { app } from "electron";'],
    ["apps/desktop/src/preload", 'import { contextBridge } from "electron";'],
    ["apps/desktop/src/preload", 'import { Channels } from "@gram/shell/channels";'],
    ["apps/desktop/src/preload", 'import type { DesktopBridge } from "@gram/contracts";'],
    ["apps/desktop/src/main", 'import { createLogger } from "@gram/server/logging";'],
  ])("allows in %s: %s", (dir, source) => {
    expect(restricted(dir, source)).toBe(false);
  });
});

const crosses = (dir, specifier) =>
  probeConfig(dir, `import { x } from "${specifier}";\nexport const probe = x;\n`).includes(
    "gram(no-cross-package-path)",
  );

describe("no-cross-package-path", () => {
  it("refuses a relative path out of one package's sources into another package or app", () => {
    expect(crosses("packages/git/src", "../../server/src/main")).toBe(true);
    expect(crosses("packages/server/src", "../../../apps/web/src/main")).toBe(true);
  });

  it("allows a relative path that stays inside the package", () => {
    expect(crosses("packages/server/src", "./main")).toBe(false);
  });
});

describe("settings-entry", () => {
  const rule = "gram/settings-entry";

  it("refuses a plain link or navigate to /settings, which pushes a copy of the open tab", () => {
    const found = lint(
      `export const a = <Link to="/settings" />;
      export const b = <Link to={setup ? "/settings" : "/settings/diagnostics"} />;
      navigate({ to: "/settings" });
      navigate({ "to": \`/settings/\`, replace: false });
      router.navigate({ to: "/settings" as const });
    `,
      rule,
      ".tsx",
    );
    expect(found.map((d) => d.labels[0].span.line)).toEqual([1, 2, 3, 4, 5]);
    expect(found[0].message).toContain("useSettingsLink");
  });

  it("allows a tab's own address, a preload, and the helpers' links", () => {
    expect(
      lint(
        `export const a = <Link to="/settings/usage" />;
        export const b = <Link {...useSettingsLink()} />;
        navigate({ to: "/settings/routines" });
        router.preloadRoute({ to: "/settings" });
        export const c = { from: "/settings" };
      `,
        rule,
        ".tsx",
      ),
    ).toEqual([]);
  });

  it("is on for the web app under the repository's own config", () => {
    const source = 'navigate({ to: "/settings" });\n';
    expect(probeConfig("apps/web/src", source)).toContain("gram(settings-entry)");
    expect(probeConfig("packages/server/src", source)).not.toContain("gram(settings-entry)");
  });
});
