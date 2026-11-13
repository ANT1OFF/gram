// Explicit native qualification of pinned pages' session: the installed pinned Electron in an owned
// temporary profile, with no outside network and no paid CLI. Run with host Node:
//   node apps/desktop/scripts/verify-pinned-pages.mjs <new evidence directory>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

const output = resolvePath(process.argv[2] ?? "");
assert(process.argv[2], "Name a new evidence directory");
mkdirSync(output); // Refuse overwriting evidence.
const owned = mkdtempSync("/tmp/gram-pinned-pages-");
const profile = join(owned, "profile");
mkdirSync(profile);
const entry = join(owned, "fixture.cjs");
try {
  execFileSync("bun", [
    "build",
    "apps/desktop/scripts/fixtures/pinned-pages.mjs",
    "--target=node",
    "--format=cjs",
    "--external=electron",
    `--outfile=${entry}`,
  ]);
  // The page guard preload, built as the app's preload bundle builds it: one file, Electron its
  // only import.
  const guard = join(owned, "page-guard.js");
  execFileSync("bun", [
    "build",
    "apps/desktop/src/preload/page-guard.ts",
    "--target=node",
    "--format=cjs",
    "--external=electron",
    `--outfile=${guard}`,
  ]);
  const require = createRequire(import.meta.url);
  const child = spawn(require("electron"), [entry, profile, guard], {
    // The display alone, for the window whose clicks give the page the user's activation and
    // whose clipboard is checked; nothing else of this environment.
    env: {
      PATH: process.env.PATH,
      HOME: owned,
      TMPDIR: owned,
      ...Object.fromEntries(
        ["DISPLAY", "XAUTHORITY"].flatMap((name) =>
          process.env[name] === undefined ? [] : [[name, process.env[name]]],
        ),
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The fixture didn't finish\n${stderr}`));
    }, 240_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith("{")) return;
      const message = JSON.parse(line);
      if (message.type !== "fixture.result") return;
      clearTimeout(timer);
      resolve(message);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The fixture exited (${code}) without a result\n${stderr}`));
    });
  });
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => child.kill(), 5000).unref();
  });
  writeFileSync(join(output, "evidence.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(result.failures, [], "Every pinned page check holds");
} finally {
  rmSync(owned, { recursive: true, force: true });
}
