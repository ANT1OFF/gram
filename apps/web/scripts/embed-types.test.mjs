import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TYPES, writeDeclarations } from "./embed-types.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(webDir, "package.json"));
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin/tsc");

// Under the workspace's own node_modules, so the declarations find React and the libraries they
// name the way an app's installed copy of the package does.
const cache = join(webDir, "../../node_modules/.tmp");
let pkg = "";
let app = "";

beforeAll(() => {
  mkdirSync(cache, { recursive: true });
  pkg = mkdtempSync(join(cache, "gram-web-kit-"));
  app = mkdtempSync(join(cache, "kit-consumer-"));
  writeDeclarations(pkg);
}, 120_000);

afterAll(() => {
  for (const dir of [pkg, app]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the package's declarations", () => {
  it("writes the two entries and every kept module", () => {
    expect(existsSync(join(pkg, "gram-web.d.ts"))).toBe(true);
    expect(existsSync(join(pkg, "gram-web-kit.d.ts"))).toBe(true);
    expect(existsSync(join(pkg, "gram-web-kit-lite.d.ts"))).toBe(true);
    for (const name of TYPES) expect(existsSync(join(pkg, "types", `${name}.d.ts`))).toBe(true);
  });

  it("types an app's page on the kit, from the declarations alone", () => {
    copyFileSync(join(webDir, "scripts/kit-consumer.fixture.tsx"), join(app, "page.tsx"));
    copyFileSync(join(webDir, "scripts/kit-lite-consumer.fixture.tsx"), join(app, "sign-in.tsx"));
    writeFileSync(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2024",
          lib: ["ES2024", "DOM", "DOM.Iterable"],
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          paths: {
            "@gram/web/kit": [join(pkg, "gram-web-kit.d.ts")],
            "@gram/web/kit-lite": [join(pkg, "gram-web-kit-lite.d.ts")],
          },
        },
        files: ["page.tsx", "sign-in.tsx"],
      }),
    );
    const result = spawnSync(process.execPath, [tsc, "--project", join(app, "tsconfig.json")], {
      cwd: app,
      encoding: "utf8",
    });
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  }, 120_000);

  it("types the same pages under NodeNext, as an ES module package", () => {
    // The package ships as `"type": "module"`, where NodeNext asks every relative path for its
    // extension.
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(join(webDir, "scripts/kit-consumer.fixture.tsx"), join(app, "page.tsx"));
    copyFileSync(join(webDir, "scripts/kit-lite-consumer.fixture.tsx"), join(app, "sign-in.tsx"));
    writeFileSync(
      join(app, "tsconfig.node.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2024",
          lib: ["ES2024", "DOM", "DOM.Iterable"],
          module: "nodenext",
          moduleResolution: "nodenext",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
          paths: {
            "@gram/web/kit": [join(pkg, "gram-web-kit.d.ts")],
            "@gram/web/kit-lite": [join(pkg, "gram-web-kit-lite.d.ts")],
          },
        },
        files: ["page.tsx", "sign-in.tsx"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [tsc, "--project", join(app, "tsconfig.node.json")],
      { cwd: app, encoding: "utf8" },
    );
    // Only the package's own declarations: the libraries they name are checked by their authors.
    const ours = `${result.stdout}${result.stderr}`
      .split("\n")
      .filter((line) => line.includes(pkg) || /^(page|sign-in)\.tsx/.test(line));
    expect(ours).toEqual([]);
  }, 120_000);
});
