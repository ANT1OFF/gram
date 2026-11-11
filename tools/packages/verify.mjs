#!/usr/bin/env node
// Checks the packed tarballs the way a consumer meets them: installed with npm into an empty
// project outside this workspace, every export imported, their types read, and the server and the
// host started from their installed commands. Publishes nothing; dependencies come from npm.
//
//   node tools/packages/verify.mjs [--out out/packages]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PREBUILT } from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: { out: { type: "string", default: "out/packages" }, keep: { type: "boolean" } },
});
const out = resolve(root, values.out);
const packed = JSON.parse(readFileSync(join(out, "packages.json"), "utf8"));
const workspace = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const catalog = workspace.workspaces.catalog;

const project = mkdtempSync(join(tmpdir(), "gram-packages-"));
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: project, encoding: "utf8", ...options });
const step = (name) => console.log(`\n== ${name}`);

try {
  step(`install ${packed.packages.length} tarballs in ${project}`);
  // Each package under its workspace name, as a consumer's alias installs it. The overrides point
  // the packages' own dependencies on one another at the tarballs, since nothing is published.
  const tarballs = Object.fromEntries(
    packed.packages.map((entry) => [entry.workspaceName, `file:${join(out, entry.tarball)}`]),
  );
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "gram-packages-consumer",
        private: true,
        type: "module",
        // The peers the packages name, at the exact versions they name.
        dependencies: {
          ...tarballs,
          effect: catalog.effect,
          react: catalog.react,
          "react-dom": catalog["react-dom"],
        },
        devDependencies: { "@types/react": catalog["@types/react"] },
        overrides: tarballs,
      },
      null,
      2,
    )}\n`,
  );
  // An empty user config: no login and no registry setting of this machine's is read.
  writeFileSync(join(project, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  run("npm", ["install", "--no-audit", "--no-fund", "--userconfig", join(project, ".npmrc")], {
    stdio: "inherit",
  });
  // One Effect: a second copy, or one the platform packages reject, breaks services at run time.
  run("npm", ["ls", "effect", "--all"], { stdio: ["ignore", "ignore", "inherit"] });

  step("import every export");
  const installed = (entry) =>
    JSON.parse(
      readFileSync(join(project, "node_modules", entry.workspaceName, "package.json"), "utf8"),
    );
  // The server's `main` starts the server on import; it is started below instead.
  const mains = new Set(["@gram/server/main"]);
  // A browser bundle doesn't load under Node: its entries are typechecked and its files checked.
  const browser = new Set(PREBUILT.map((each) => each.folder));
  const forBrowser = new Set();
  const specifiers = packed.packages.flatMap((entry) => {
    const manifest = installed(entry);
    if (manifest.name !== entry.name || manifest.version !== entry.version) {
      throw new Error(`${entry.workspaceName} installed as ${manifest.name}@${manifest.version}`);
    }
    for (const section of ["dependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (/^(workspace|catalog):/.test(spec)) throw new Error(`${entry.name}: ${name}@${spec}`);
      }
    }
    return Object.entries(manifest.exports).flatMap(([key, target]) => {
      const files = typeof target === "string" ? [target] : Object.values(target);
      for (const file of files) {
        if (!existsSync(join(project, "node_modules", entry.workspaceName, file))) {
          throw new Error(`${entry.name}: export ${key} names ${file}, which isn't installed`);
        }
      }
      // A stylesheet: nothing to import or typecheck.
      if (typeof target === "string") return [];
      const specifier = `${entry.workspaceName}${key.slice(1)}`;
      if (browser.has(entry.folder)) forBrowser.add(specifier);
      return [specifier];
    });
  });
  writeFileSync(
    join(project, "imports.mjs"),
    specifiers
      .filter((specifier) => !mains.has(specifier) && !forBrowser.has(specifier))
      .map((specifier) => `await import(${JSON.stringify(specifier)});`)
      .join("\n"),
  );
  run(process.execPath, ["imports.mjs"], { stdio: "inherit" });
  console.log(
    `${specifiers.length - mains.size - forBrowser.size} entries import under plain Node`,
  );

  step("read the published types");
  // `any` is what a declaration that fails to resolve turns into, so no export may be `any`.
  writeFileSync(
    join(project, "types.ts"),
    [
      ...specifiers.map((specifier, index) => `import * as m${index} from "${specifier}";`),
      "type IsAny<T> = 0 extends 1 & T ? true : false;",
      "type Members<T> = { [K in keyof T]: IsAny<T[K]> }[keyof T];",
      ...specifiers.map(
        (_, index) =>
          `export const check${index}: true extends Members<typeof m${index}> ? never : 0 = 0;`,
      ),
    ].join("\n"),
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2024",
        lib: ["ES2024", "DOM"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [join(root, "node_modules/@types")],
      },
      files: ["types.ts"],
    }),
  );
  run(join(root, "node_modules/.bin/tsc"), ["-p", "."], { stdio: "inherit" });
  console.log(`${specifiers.length} entries typecheck in a consumer`);

  step("start the installed commands");
  const bin = (name) => join(project, "node_modules/.bin", name);
  const home = join(project, "host-home");
  mkdirSync(home);
  const status = run(bin("gram-host"), ["status"], {
    env: { ...process.env, GRAM_HOST_HOME: home },
  });
  if (!status.includes("Not joined")) throw new Error(`gram-host status said: ${status}`);
  console.log("gram-host runs");
  // Once in the server's own process and once with this machine's host as a child, which finds
  // its entry beside the built module.
  for (const hostProcess of ["0", "1"]) {
    await new Promise((done, fail) => {
      const data = join(project, `data-${hostProcess}`);
      const child = spawn(bin("gram-server"), [], {
        cwd: project,
        env: {
          ...process.env,
          GRAM_FAKE_AGENT: "1",
          GRAM_DATA_DIR: data,
          GRAM_PORT: "0",
          GRAM_HOST_PROCESS: hostProcess,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let seen = "";
      let booted = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const read = (chunk) => {
        seen += chunk;
        // The boot line carries the launch token, so it is matched and never printed.
        if (!booted && /^boot http/m.test(seen)) {
          booted = true;
          child.kill("SIGTERM");
        }
      };
      child.stdout.setEncoding("utf8").on("data", read);
      child.stderr.setEncoding("utf8").on("data", read);
      child.on("error", fail);
      child.on("exit", () => {
        clearTimeout(timer);
        if (booted) done();
        else fail(new Error(`gram-server didn't boot (GRAM_HOST_PROCESS=${hostProcess})`));
      });
    });
    console.log(`gram-server boots with GRAM_HOST_PROCESS=${hostProcess}`);
  }
  console.log(`\nPackages verified at ${packed.version}.`);
} finally {
  if (!values.keep) rmSync(project, { recursive: true, force: true });
}
