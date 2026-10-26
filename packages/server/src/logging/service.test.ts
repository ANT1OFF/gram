import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createLogger } from "./logger.ts";
import { loopStall, measuredBusyMs, stallCause } from "./loop-stalls.ts";
import { blockingStack, makeStallProfiler } from "./stall-profile.ts";
import { ServerLog, serverLogLayer } from "./service.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("serverLogLayer", () => {
  it.effect("sends Effect logs to the file at the live level", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-log-service-"));
      dirs.push(dir);
      const now = new Date(2026, 8, 16, 9);
      const { logger, file } = createLogger({ dir, name: "server", now: () => now });
      const layer = serverLogLayer({
        logger,
        logDir: dir,
        setLevel: (level) =>
          Effect.sync(() => {
            logger.level = level;
          }),
      });

      yield* Effect.gen(function* () {
        yield* Effect.logWarning("watchdog fired", { threadId: "t1" });
        yield* Effect.logDebug("hidden at info");
        yield* (yield* ServerLog).setLevel("debug");
        yield* Effect.logDebug("shown at debug");
      }).pipe(Effect.provide(layer));
      file.close();

      const lines = readFileSync(join(dir, "server-2026-09-16.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => [line["level"], line["msg"]])).toEqual([
        [40, 'watchdog fired {"threadId":"t1"}'],
        [20, "shown at debug"],
      ]);
    }),
  );

  it.effect("writes log annotations as fields of the line, scrubbed", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-log-service-"));
      dirs.push(dir);
      const now = new Date(2026, 8, 16, 9);
      const { logger, file } = createLogger({ dir, name: "server", now: () => now });
      const layer = serverLogLayer({ logger, logDir: dir, setLevel: () => Effect.void });

      yield* Effect.logWarning("github rate-limited a poll; backing off").pipe(
        Effect.annotateLogs({
          poll: "gitstate",
          retryInMs: 60_000,
          apiKey: "sk-planted-planted-planted",
          reason: "gh: bad credentials for ghp_abcdefghijklmnopqrstuvwxyz0123",
        }),
        Effect.provide(layer),
      );
      yield* Effect.logInfo("plain").pipe(Effect.provide(layer));
      file.close();

      const text = readFileSync(join(dir, "server-2026-09-16.log"), "utf8");
      const [annotated, plain] = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(annotated).toMatchObject({
        msg: "github rate-limited a poll; backing off",
        poll: "gitstate",
        retryInMs: 60_000,
        apiKey: "[redacted]",
        reason: "gh: bad credentials for [redacted]",
      });
      expect(Object.keys(plain ?? {}).toSorted()).toEqual(["level", "msg", "name", "pid", "time"]);
      expect(text).not.toContain("planted");
      expect(text).not.toContain("ghp_");
    }),
  );

  it.effect("defaults to a disabled logger when nothing provides one", () =>
    Effect.gen(function* () {
      const log = yield* ServerLog;
      expect(log.logDir).toBeUndefined();
      expect(log.logger.isLevelEnabled("error")).toBe(false);
    }),
  );
});

describe("loopStall", () => {
  const window = {
    maxMs: 812.4,
    p99Ms: 95.6,
    busyMs: 900,
    cpuMs: 880,
    gcMs: 12,
    gcMaxMs: 4,
    heapMb: 210.4,
    rssMb: 380.6,
  };

  it("warns only for a window with a delay past the threshold", () => {
    expect(loopStall({ ...window, maxMs: 499.9 })).toBeUndefined();
    expect(loopStall(window)).toEqual({
      maxMs: 812,
      p99Ms: 96,
      busyMs: 900,
      cpuMs: 880,
      gcMs: 12,
      gcMaxMs: 4,
      heapMb: 210,
      rssMb: 381,
      cause: "cpu",
    });
    expect(loopStall({ ...window, maxMs: 120 }, 100)?.maxMs).toBe(120);
  });

  it("names the likely cause from what else the window measured", () => {
    expect(stallCause({ ...window, gcMs: 700, gcMaxMs: 650 })).toBe("gc");
    expect(stallCause({ ...window, cpuMs: 90 })).toBe("blocked");
    expect(stallCause({ ...window, maxMs: 8000, busyMs: 300, cpuMs: 250 })).toBe("suspended");
  });

  it("does not call missing Electron ELU suspension", () => {
    const zero = { active: 0, idle: 0, utilization: 0 };
    expect(measuredBusyMs(zero, -1)).toBeNull();
    expect(measuredBusyMs(zero, 12)).toBeNull();
    expect(measuredBusyMs({ active: 20, idle: 80, utilization: 0.2 }, 12)).toBe(20);
    expect(loopStall({ ...window, busyMs: null, cpuMs: 50 })).toMatchObject({
      busyMs: null,
      cause: "unknown",
    });
    expect(stallCause({ ...window, busyMs: null })).toBe("cpu");
    expect(stallCause({ ...window, busyMs: null, gcMaxMs: 650 })).toBe("gc");
  });
});

const frame = (functionName: string, url = "", lineNumber = 0) => ({
  functionName,
  scriptId: "0",
  url,
  lineNumber,
  columnNumber: 0,
});

describe("blockingStack", () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 3] },
      { id: 2, callFrame: frame("(idle)") },
      {
        id: 3,
        callFrame: frame("ledger", "file:///app/out/server/server.js", 41),
        children: [4, 5],
      },
      { id: 4, callFrame: frame("overlapPairs", "file:///app/out/server/server.js", 9) },
      { id: 5, callFrame: frame("") },
    ],
    startTime: 0,
    endTime: 100_000,
    samples: [2, 3, 4, 4, 4, 5, 2, 4, 2],
    timeDeltas: [0, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
  };

  it("names the longest stretch the loop never went idle in", () => {
    expect(blockingStack(profile)).toEqual({
      ms: 50,
      path: ["ledger server.js:42", "overlapPairs server.js:10"],
      hottest: "overlapPairs server.js:10",
    });
    expect(blockingStack({ ...profile, samples: [2, 2] })).toBeUndefined();
    // One sample standing for a second outweighs five of 10 ms each beside it.
    expect(
      blockingStack({
        ...profile,
        samples: [2, 5, 4, 4, 4, 4, 4, 2],
        timeDeltas: [0, 0, 1_000_000, 10_000, 10_000, 10_000, 10_000, 10_000],
      }),
    ).toEqual({ ms: 1050, path: ["ledger server.js:42", "(anonymous)"], hottest: "(anonymous)" });
  });

  it.effect("samples this process while armed", () =>
    Effect.gen(function* () {
      const profiler = yield* makeStallProfiler;
      if (profiler === undefined) return;
      yield* profiler.start;
      const busyUntil = performance.now() + 300;
      const spinForAWhile = () => {
        let spins = 0;
        while (performance.now() < busyUntil) spins += 1;
        return spins;
      };
      spinForAWhile();
      const found = blockingStack((yield* profiler.stop)!);
      expect(found?.path.some((text) => text.startsWith("spinForAWhile "))).toBe(true);
      expect(yield* profiler.stop).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
