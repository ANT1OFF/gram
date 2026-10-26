import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { NOTARY_BACKOFF_MS, preflightNotary } from "./notary-preflight.mjs";
import { resolveSigning } from "./rc-lib.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(failures, message) {
  const root = mkdtempSync(join(tmpdir(), "gram-fake-xcrun-"));
  dirs.push(root);
  const log = join(root, "calls.json");
  writeFileSync(log, "[]");
  const xcrun = join(root, "xcrun");
  writeFileSync(
    xcrun,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const log = process.env.FAKE_LOG;
const calls = JSON.parse(readFileSync(log, "utf8"));
calls.push(process.argv.slice(2));
writeFileSync(log, JSON.stringify(calls));
console.error(${JSON.stringify(message)});
process.exit(calls.length <= ${failures} ? 1 : 0);
`,
    { mode: 0o755 },
  );
  const waits = [];
  const said = [];
  const check = () =>
    preflightNotary({
      profile: "fake-profile",
      env: { FAKE_LOG: log },
      xcrun,
      wait: (ms) => waits.push(ms),
      say: (s) => said.push(s),
    });
  return { check, waits, said, calls: () => JSON.parse(readFileSync(log, "utf8")) };
}

it("recovers from the transient password-item error with bounded exponential backoff", () => {
  const f = fixture(3, "No Keychain password item found SECRET-OUTPUT");
  expect(f.check()).toBe(true);
  expect(f.waits).toEqual(NOTARY_BACKOFF_MS.slice(0, 3));
  expect(f.calls()).toEqual(
    Array.from({ length: 4 }, () => [
      "notarytool",
      "history",
      "--keychain-profile",
      "fake-profile",
      "--output-format",
      "json",
    ]),
  );
  expect(f.said.join("\n")).not.toContain("SECRET-OUTPUT");
});

it("does not retry a successful preflight", () => {
  const f = fixture(0, "");
  expect(f.check()).toBe(true);
  expect(f.waits).toEqual([]);
  expect(f.calls()).toHaveLength(1);
});

it.each([
  ["The keychain is locked SECRET-OUTPUT", "keychain locked or unavailable"],
  ["User interaction is not allowed (-25308)", "keychain locked or unavailable"],
  ["No Keychain password item found", "cannot distinguish"],
  ["Profile fake-profile does not exist", "profile missing"],
  ["Service unavailable", "profile or Apple service"],
  ["HTTP 503 SECRET-OUTPUT", "profile or Apple service"],
])("diagnoses final failure without printing raw output: %s", (message, diagnosis) => {
  const f = fixture(99, message);
  const reason = f.check();
  expect(reason).toContain(diagnosis);
  expect(reason).toContain("normal Terminal before re-creating anything");
  expect(reason).toContain("xcrun notarytool history --keychain-profile <name>");
  expect(reason).not.toContain("SECRET-OUTPUT");
  expect(f.waits).toEqual(NOTARY_BACKOFF_MS);
  expect(f.calls()).toHaveLength(5);
  const signing = {
    mode: "signed",
    teamId: "FAKETEAM01",
    identityLines: [`  1) ${"A".repeat(40)} "Developer ID Application: Example (FAKETEAM01)"`],
    profile: "fake-profile",
    checkProfile: () => reason,
  };
  expect(() => resolveSigning(signing)).toThrow(diagnosis);
  expect(resolveSigning({ ...signing, mode: "auto" })).toMatchObject({ signed: false, reason });
});
