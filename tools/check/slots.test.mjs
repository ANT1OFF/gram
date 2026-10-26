import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireSlot,
  clearRun,
  holders,
  readRun,
  runFile,
  slotCount,
  slotDir,
  tryClaim,
  workersPerSlot,
  writeRun,
} from "./slots.mjs";

const dirs = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-slots-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const owner = (pid = process.pid) => ({ pid, host: hostname(), cwd: "/w", since: "now" });

/** A pid that was ours and has certainly exited. */
const deadPid = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid));
  });

describe("check slots", () => {
  it("sizes slots and workers from the machine unless configured", () => {
    expect(slotCount({}, 18)).toBe(2);
    expect(slotCount({}, 4)).toBe(1);
    expect(slotCount({ GRAM_CHECK_SLOTS: "3" }, 18)).toBe(3);
    expect(() => slotCount({ GRAM_CHECK_SLOTS: "0" }, 18)).toThrow(/GRAM_CHECK_SLOTS/);
    expect(workersPerSlot(2, 18)).toBe(8);
    expect(workersPerSlot(1, 4)).toBe(2);
    expect(slotDir({ GRAM_CHECK_SLOT_DIR: "/x" })).toBe("/x");
    expect(slotDir({ XDG_CACHE_HOME: "/c" })).toBe(join("/c", "gram", "check-slots"));
  });

  it("gives out each slot once while its holder lives", () => {
    const dir = fresh();
    const first = tryClaim({ dir, slots: 2, owner: owner() });
    const second = tryClaim({ dir, slots: 2, owner: owner() });
    expect(first).not.toBe(second);
    expect(tryClaim({ dir, slots: 2, owner: owner() })).toBeUndefined();
    expect(holders(dir)).toHaveLength(2);
  });

  it("reclaims a slot whose holder died, or never said who it was", async () => {
    const dir = fresh();
    const dead = await deadPid();
    const claimed = tryClaim({ dir, slots: 1, owner: owner(dead) });
    expect(JSON.parse(readFileSync(join(claimed, "owner.json"), "utf8")).pid).toBe(dead);
    expect(tryClaim({ dir, slots: 1, owner: owner() })).toBe(claimed);
    expect(JSON.parse(readFileSync(join(claimed, "owner.json"), "utf8")).pid).toBe(process.pid);

    const other = fresh();
    mkdirSync(join(other, "slot-0"));
    expect(tryClaim({ dir: other, slots: 1, owner: owner(), graceMs: 60_000 })).toBeUndefined();
    expect(
      tryClaim({
        dir: other,
        slots: 1,
        owner: owner(),
        now: Date.now() + 120_000,
        graceMs: 60_000,
      }),
    ).toBe(join(other, "slot-0"));
  });

  it("never reclaims another machine's slot on a shared cache", () => {
    const dir = fresh();
    mkdirSync(join(dir, "slot-0"));
    writeFileSync(
      join(dir, "slot-0", "owner.json"),
      JSON.stringify({ pid: 1 << 30, host: `${hostname()}-other`, cwd: "/w", since: "now" }),
    );
    expect(tryClaim({ dir, slots: 1, owner: owner() })).toBeUndefined();
  });

  it("waits for a held slot and takes it once released", async () => {
    const dir = fresh();
    const releaseFirst = await acquireSlot({ dir, slots: 1, pollMs: 10 });
    let waitedFor;
    let secondHeld = false;
    const second = acquireSlot({
      dir,
      slots: 1,
      pollMs: 10,
      onWait: (who) => (waitedFor = who),
    }).then((free) => {
      secondHeld = true;
      return free;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondHeld).toBe(false);
    expect(waitedFor?.[0]?.pid).toBe(process.pid);
    releaseFirst();
    const releaseSecond = await second;
    expect(secondHeld).toBe(true);
    releaseSecond();
    expect(holders(dir)).toEqual([]);
  });
});

describe("running checks", () => {
  it("keeps one record per checkout, so a cancel finds only its own check", () => {
    const dir = join(fresh(), "check-slots");
    expect(runFile("/w/a", dir)).not.toBe(runFile("/w/b", dir));
    writeRun("/w/a", { pid: process.pid, since: "now", groups: [123] }, dir);
    expect(readRun("/w/a", dir)).toMatchObject({ pid: process.pid, groups: [123] });
    expect(readRun("/w/b", dir)).toBeUndefined();
    // Another process's record is not this one's to clear.
    clearRun("/w/a", process.pid + 1, dir);
    expect(readRun("/w/a", dir)).toBeDefined();
    clearRun("/w/a", process.pid, dir);
    expect(readRun("/w/a", dir)).toBeUndefined();
  });

  it("ignores a record another machine wrote on a shared cache", () => {
    const dir = join(fresh(), "check-slots");
    writeRun("/w/a", { pid: process.pid, since: "now", groups: [] }, dir);
    const path = runFile("/w/a", dir);
    const run = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...run, host: `${hostname()}-other` }));
    expect(readRun("/w/a", dir)).toBeUndefined();
  });
});
