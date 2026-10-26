import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createLogger", () => {
  it("writes JSON lines with secrets censored and honours a live level change", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-logger-"));
    dirs.push(dir);
    const now = new Date(2026, 8, 16, 10);
    const { logger, file } = createLogger({ dir, name: "server", now: () => now });

    logger.info({ token: "abc", profile: { apiKey: "xyz" } }, "signed in");
    logger.debug("hidden at info");
    logger.level = "debug";
    logger.debug("shown at debug");
    file.close();

    const lines = readFileSync(join(dir, "server-2026-09-16.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line["msg"])).toEqual(["signed in", "shown at debug"]);
    expect(lines[0]).toMatchObject({
      name: "server",
      token: "[redacted]",
      profile: { apiKey: "[redacted]" },
    });
    expect(typeof lines[0]?.["time"]).toBe("string");
  });
});
