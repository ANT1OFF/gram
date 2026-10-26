import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dailyFile, latestLogFile, localDay, pruneLogs, tailLines } from "./daily-file.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-log-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dailyFile", () => {
  it("writes redacted lines to one file per local day", () => {
    const dir = tempDir();
    let now = new Date(2026, 8, 15, 23, 59);
    const file = dailyFile({ dir, name: "server", now: () => now });

    file.write('{"msg":"boot http://127.0.0.1:1/?boot=secret-token"}\n');
    now = new Date(2026, 8, 16, 0, 1);
    file.write('{"msg":"next day"}\n');
    file.close();

    expect(readdirSync(dir).toSorted()).toEqual(["server-2026-09-15.log", "server-2026-09-16.log"]);
    expect(readFileSync(join(dir, "server-2026-09-15.log"), "utf8")).toBe(
      '{"msg":"boot http://127.0.0.1:1/?boot=[redacted]"}\n',
    );
    expect(latestLogFile(dir, "server")).toBe(join(dir, "server-2026-09-16.log"));
  });

  it("echoes lines and keeps going when the folder can't be created", () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "");
    const echoed: string[] = [];
    const file = dailyFile({
      dir: join(blocker, "logs"),
      name: "server",
      echo: (l) => echoed.push(l),
    });
    expect(file.write("one\n")).toBe(true);
    expect(file.write("two\n")).toBe(true);
    expect(echoed).toEqual(["one\n", "two\n"]);
  });
});

describe("pruneLogs", () => {
  it("removes files dated before the retention window and ignores other names", () => {
    const dir = tempDir();
    for (const name of [
      "server-2026-09-01.log",
      "server-2026-09-09.log",
      "server-2026-09-16.log",
      "desktop-2026-09-01.log",
      "notes.txt",
    ]) {
      writeFileSync(join(dir, name), "");
    }
    pruneLogs(dir, "server", new Date(2026, 8, 16, 12), 7);
    expect(readdirSync(dir).toSorted()).toEqual([
      "desktop-2026-09-01.log",
      "notes.txt",
      "server-2026-09-09.log",
      "server-2026-09-16.log",
    ]);
  });
});

describe("pruneLogs across a daylight-saving change", () => {
  const zone = process.env["TZ"];
  afterEach(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  it("counts the retention window in calendar days, not 24-hour steps", () => {
    process.env["TZ"] = "Europe/London";
    const dir = tempDir();
    for (const name of ["server-2026-03-22.log", "server-2026-03-23.log"])
      writeFileSync(join(dir, name), "");
    // 00:30 BST on 30 March. Seven 24-hour steps back is 23:30 GMT on 22 March, a day too far.
    pruneLogs(dir, "server", new Date(2026, 2, 30, 0, 30), 7);
    expect(readdirSync(dir)).toEqual(["server-2026-03-23.log"]);
  });
});

describe("tailLines", () => {
  it("returns the last lines, dropping a line cut short by the byte limit", () => {
    const dir = tempDir();
    const file = join(dir, "server-2026-09-16.log");
    writeFileSync(file, ["first line", "second", "third", ""].join("\n"));
    expect(tailLines(file, 2)).toEqual(["second", "third"]);
    expect(tailLines(file, 10, 14)).toEqual(["second", "third"]);
    expect(tailLines(join(dir, "missing.log"), 5)).toEqual([]);
  });
});

describe("localDay", () => {
  it("pads months and days", () => {
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
