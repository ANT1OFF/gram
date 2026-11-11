import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DeviceLogEntry, openDeviceLog, readDeviceLog } from "./log.ts";

let dir: string;
let file: string;
const key = randomBytes(32);

const entry = (what: string, more: Partial<DeviceLogEntry> = {}): DeviceLogEntry => ({
  time: 1_800_000_000_000,
  origin: "https://gram.example.com",
  workspace: "w1",
  thread: "t1",
  threadTitle: "Fix the build",
  folder: "/home/ada/code/app",
  kind: "exec",
  what,
  answer: "allowed",
  exitCode: 0,
  ...more,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "gram-log-"));
  file = join(dir, "device.log");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const written = async (commands: ReadonlyArray<string>) => {
  const log = await openDeviceLog(file, key);
  // Not awaited one by one: lines must still land in the order they were asked.
  await Promise.all(commands.map((command) => log.append(entry(command))));
  return log.head();
};

describe("the local log", () => {
  it("reads back what was written, in order, and is empty before anything is", async () => {
    expect(await readDeviceLog(file, key)).toMatchObject({ entries: [], intact: true });
    const head = await written(["npm test", "ls\nrm -rf ~", "git status"]);
    const read = await readDeviceLog(file, key, head);
    expect(read.intact).toBe(true);
    expect(read.entries.map((line) => line.what)).toEqual([
      "npm test",
      "ls\nrm -rf ~",
      "git status",
    ]);
    expect(head.count).toBe(3);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o077).toBe(0);
  });

  it("continues the chain when the app opens it again", async () => {
    await written(["one"]);
    const again = await openDeviceLog(file, key);
    expect(again.foundEdited).toBe(false);
    const head = await again.append(entry("two", { answer: "not-allowed-by-person" }));
    const read = await readDeviceLog(file, key, head);
    expect(read).toMatchObject({ intact: true, head: { count: 2 } });
  });

  it("says when a line was changed, removed, reordered or added", async () => {
    await written(["one", "two", "three"]);
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    const [one = "", two = "", three = ""] = lines;
    for (const [name, edited, good] of [
      ["changed", [one, two.replace("two", "2wo"), three], 1],
      ["removed", [one, three], 1],
      ["reordered", [two, one, three], 0],
      ["added", [one, two, three, three], 3],
      ["not a line", [one, "{}", three], 1],
    ] as const) {
      await fs.writeFile(file, `${edited.join("\n")}\n`);
      const read = await readDeviceLog(file, key);
      expect(read.intact, name).toBe(false);
      expect(read.entries, name).toHaveLength(good);
    }
  });

  it("says when lines were cut off the end, given where it stood", async () => {
    const head = await written(["one", "two", "three"]);
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    await fs.writeFile(file, `${lines.slice(0, 2).join("\n")}\n`);
    // Each remaining line checks out, so only the kept head shows the cut.
    expect((await readDeviceLog(file, key)).intact).toBe(true);
    expect((await readDeviceLog(file, key, head)).intact).toBe(false);
    await fs.rm(file);
    expect((await readDeviceLog(file, key, head)).intact).toBe(false);
  });

  it("can't be forged without the key", async () => {
    await written(["one"]);
    expect((await readDeviceLog(file, randomBytes(32))).intact).toBe(false);
  });

  it("sets an edited log aside and starts again from its last good line", async () => {
    await written(["one", "two", "three"]);
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    await fs.writeFile(file, `${[lines[0], "forged", lines[2]].join("\n")}\n`);
    const log = await openDeviceLog(file, key);
    expect(log.foundEdited).toBe(true);
    expect(await fs.readFile(`${file}.edited`, "utf8")).toContain("forged");
    const head = await log.append(entry("four"));
    const read = await readDeviceLog(file, key, head);
    expect(read.intact).toBe(true);
    expect(read.entries.map((line) => line.what)).toEqual(["one", "four"]);
  });
});
