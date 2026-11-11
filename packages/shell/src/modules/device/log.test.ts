import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  await log.close();
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
    await again.close();
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
      ["blank line", [one, "", two, three], 1],
      ["spaced", [one, two.replace('","', '", "'), three], 1],
      ["carriage return", [one, `${two}\r`, three], 1],
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
    expect(await fs.readFile(log.setAside ?? "", "utf8")).toContain("forged");
    const head = await log.append(entry("four"));
    await log.close();
    const read = await readDeviceLog(file, key, head);
    expect(read.intact).toBe(true);
    expect(read.entries.map((line) => line.what)).toEqual(["one", "four"]);
  });

  it("keeps every edited copy, never writing over an earlier one", async () => {
    await written(["one", "two"]);
    await fs.appendFile(file, "first edit\n");
    const first = await openDeviceLog(file, key);
    await first.close();
    await fs.appendFile(file, "second edit\n");
    const second = await openDeviceLog(file, key);
    await second.close();
    expect(first.setAside).not.toBe(second.setAside);
    expect(await fs.readFile(first.setAside ?? "", "utf8")).toContain("first edit");
    expect(await fs.readFile(second.setAside ?? "", "utf8")).toContain("second edit");
    const sideFiles = (await fs.readdir(dir)).filter((name) => name.includes(".edited-"));
    expect(sideFiles).toHaveLength(2);
  });

  it("isn't an edit when the file has lines the kept head hasn't caught up with", async () => {
    const log = await openDeviceLog(file, key);
    const kept = await log.append(entry("one"));
    await log.append(entry("written as the app quit"));
    await log.close();
    const read = await readDeviceLog(file, key, kept);
    expect(read).toMatchObject({ intact: true, head: { count: 2 } });
    const again = await openDeviceLog(file, key, kept);
    expect(again.foundEdited).toBe(false);
    await again.close();
  });

  it("cuts a line that didn't land whole, so the next ones still chain", async () => {
    const log = await openDeviceLog(file, key);
    await log.append(entry("one"));
    // The next write lands half a line and then fails, as a full disk leaves it.
    const probe = await fs.open(join(dir, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...args: Array<unknown>) => unknown;
    };
    await probe.close();
    const real = prototype.write;
    const spy = vi.spyOn(prototype, "write").mockImplementationOnce(async function (
      this: unknown,
      buffer: unknown,
      offset: unknown,
      length: unknown,
      position: unknown,
    ) {
      await real.call(this, buffer, offset, Math.floor(Number(length) / 2), position);
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    await expect(log.append(entry("lost"))).rejects.toThrow("no space");
    spy.mockRestore();
    await log.append(entry("two"));
    await log.append(entry("three"));
    await log.close();
    const read = await readDeviceLog(file, key, log.head());
    expect(read.intact).toBe(true);
    expect(read.entries.map((line) => line.what)).toEqual(["one", "two", "three"]);
  });

  it.skipIf(process.platform === "win32")(
    "won't write through a link, and keeps the file to its user",
    async () => {
      const elsewhere = join(dir, "elsewhere.txt");
      await fs.writeFile(elsewhere, "keep me");
      await fs.symlink(elsewhere, file);
      await expect(openDeviceLog(file, key)).rejects.toThrow();
      expect(await fs.readFile(elsewhere, "utf8")).toBe("keep me");
      await fs.rm(file);
      await fs.writeFile(file, "", { mode: 0o644 });
      await fs.chmod(file, 0o644);
      const log = await openDeviceLog(file, key);
      await log.append(entry("one"));
      await log.close();
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      await fs.rm(file);
      await fs.writeFile(elsewhere, "");
      await fs.link(elsewhere, file);
      await expect(openDeviceLog(file, key)).rejects.toThrow();
    },
  );

  it("takes a line cut short by a crash as unfinished, not as an edit", async () => {
    const log = await openDeviceLog(file, key);
    const head = await log.append(entry("one"));
    await log.close();
    await fs.appendFile(file, '["abc","{\\"ti');
    expect(await readDeviceLog(file, key, head)).toMatchObject({
      intact: true,
      head: { count: 1 },
    });
    const again = await openDeviceLog(file, key, head);
    expect(again.foundEdited).toBe(false);
    const next = await again.append(entry("two"));
    await again.close();
    const read = await readDeviceLog(file, key, next);
    expect(read.intact).toBe(true);
    expect(read.entries.map((line) => line.what)).toEqual(["one", "two"]);
  });

  it("refuses to write once the file was moved away and replaced", async () => {
    const log = await openDeviceLog(file, key);
    await log.append(entry("one"));
    await fs.rename(file, `${file}.away`);
    await fs.copyFile(`${file}.away`, file);
    await expect(log.append(entry("two"))).rejects.toThrow(/moved or replaced/);
    await log.close();
  });

  it("reads a long log in time that grows with its length, not its square", async () => {
    const first = await (async () => {
      const log = await openDeviceLog(file, key);
      await log.append(entry("x".repeat(300)));
      await log.close();
      return { text: await fs.readFile(file, "utf8"), mac: log.head().mac };
    })();
    // The lines between are built here and written in one go, chained as the appender chains
    // them: appended one by one, each waits on its own flush to disk, which under Node on a Mac
    // takes over a minute for twenty thousand.
    const after = (previous: string, value: DeviceLogEntry) => {
      const body = JSON.stringify(value);
      const mac = createHmac("sha256", key)
        .update(previous)
        .update("\n")
        .update(body)
        .digest("hex");
      return { mac, line: `${JSON.stringify([mac, body])}\n` };
    };
    // Built this way, the appender's own line comes out byte for byte.
    expect(after("gram-device-log-v1", entry("x".repeat(300)))).toEqual({
      mac: first.mac,
      line: first.text,
    });
    const lines = [first.text];
    let mac = first.mac;
    for (let index = 0; index < 19_999; index++) {
      const next = after(mac, entry(`c${index}`));
      lines.push(next.line);
      mac = next.mac;
    }
    await fs.writeFile(file, lines.join(""));
    // The appender takes the built chain as its own and adds the last line.
    const many = await openDeviceLog(file, key, { count: 20_000, mac });
    expect(many.foundEdited).toBe(false);
    await many.append(entry("c19999"));
    await many.close();
    const started = performance.now();
    const read = await readDeviceLog(file, key, many.head());
    expect(read.intact).toBe(true);
    expect(read.entries).toHaveLength(20_001);
    expect(performance.now() - started).toBeLessThan(5000);
  }, 60_000);
});
