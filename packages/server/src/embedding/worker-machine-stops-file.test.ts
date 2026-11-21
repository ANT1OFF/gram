// The stops a hosted server never confirmed as this Gram keeps them on disk: what a restart reads
// back, what is never written past, and what is set aside; with a fake app over the port, no
// network, no real machine.

import { describe, expect, it } from "@effect/vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { fakeApp, NAME, ORIGIN, SERVER } from "./signed-in-fixtures.ts";
import { STOP_HOLD_MS } from "./worker-machine-stops.ts";
import {
  bridgeWorkerMachines,
  fileOwedStops,
  memoryOwedStops,
  OWED_MOST,
  stopHoldUntil,
  STOPS_FILE_MOST,
  settleOwedStops,
  signedInSource,
  type WorkerMachinePortShape,
} from "./signed-in-workers.ts";

describe("the stops owed, as they are kept on disk", () => {
  const unregistered = {
    list: () => [],
    remove: () => false,
    machines: {
      provision: () => {
        throw new Error("not registered here");
      },
    },
  };

  it.effect("settle a stop owed from before sign-ins were kept only once one is done", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        // Written before: no sign-in, nor a word that it had none.
        mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
        writeFileSync(
          join(dir, "remote-access", "worker-machine-stops.json"),
          JSON.stringify({ version: 1, owed: [{ origin: ORIGIN, name: NAME, since: 0 }] }),
          { mode: 0o600 },
        );
        let stopped = false;
        const app = fakeApp({ answer: () => ({ status: 200, body: { stopped } }) });
        const port = bridgeWorkerMachines(app.port);
        const owed = fileOwedStops(dir);
        // "No such machine" may be another sign-in's word: never settles it.
        for (let each = 0; each < 4; each += 1) yield* settleOwedStops(port, owed);
        expect(owed.list().map((each) => each.name)).toEqual([NAME]);
        // One stopped is.
        stopped = true;
        yield* settleOwedStops(port, owed);
        expect(owed.list()).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.live("hold a name across a restart after a stop no one answered", () =>
    Effect.gen(function* () {
      const log: string[] = [];
      const base = bridgeWorkerMachines(
        fakeApp({ answer: () => ({ status: 202, body: {} }) }).port,
      );
      // Every stop is posted and its answer lost; a start is answered.
      const port: WorkerMachinePortShape = {
        ...base,
        call: (_origin, call) =>
          Effect.sync(() => {
            log.push(call);
            return call === "stop"
              ? { ok: false as const, why: "no answer" }
              : { ok: true as const, status: 202, body: {} };
          }),
      };
      const dir = mkdtempSync(join(tmpdir(), "gram-held-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const before = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed: fileOwedStops(dir),
        starting: new Set(),
        stopRetryMs: 0,
        unansweredHoldMs: 0,
      });
      yield* before.abandon(NAME);
      // This Gram restarts: nothing in memory, only what is on disk.
      const after = signedInSource(SERVER, {
        port,
        hosts: unregistered,
        owed: fileOwedStops(dir),
        starting: new Set(),
        locks: makeKeyedLock<string>(),
      });
      yield* Effect.forkScoped(after.start({ name: NAME, orchestrator: "o", title: "Retry" }));
      yield* Effect.sleep("200 millis");
      // The stops may still land: the retry's start waits out their hold.
      expect(log).toEqual(["stop", "stop", "stop"]);
    }).pipe(Effect.scoped),
  );

  it.effect("send no start whose owing couldn't be written", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        const owed = fileOwedStops(dir);
        owed.add({ origin: ORIGIN, name: "worker-aaaaaaaaaa", since: 0 });
        // The folder can't be written now: a full or read-only disk.
        chmodSync(join(dir, "remote-access"), 0o500);
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed,
          starting: new Set(),
        });
        const started = yield* source.start({ name: NAME, orchestrator: "o", title: "Heavy" });
        expect(started.kind).toBe("refused");
        expect(app.calls).toEqual([]);
        chmodSync(join(dir, "remote-access"), 0o700);
        // What was owed before is still there.
        expect(
          fileOwedStops(dir)
            .list()
            .map((each) => each.name),
        ).toEqual(["worker-aaaaaaaaaa"]);
      } finally {
        chmodSync(join(dir, "remote-access"), 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("send no stop whose hold couldn't be written down, and owe it instead", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 200, body: { stopped: true } }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        const owed = fileOwedStops(dir);
        owed.add({ origin: ORIGIN, name: "worker-aaaaaaaaaa", since: 0 });
        // The folder can't be written now: a full or read-only disk.
        chmodSync(join(dir, "remote-access"), 0o500);
        const port = bridgeWorkerMachines(app.port);
        const source = signedInSource(SERVER, { port, hosts: unregistered, owed, stopRetryMs: 0 });
        // Neither a give-back's stop nor an owed one goes out with no hold kept for it.
        yield* source.abandon(NAME);
        yield* settleOwedStops(port, owed);
        expect(app.calls).toEqual([]);
        expect(owed.list().map((each) => each.name)).toContain("worker-aaaaaaaaaa");
      } finally {
        chmodSync(join(dir, "remote-access"), 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("start no machine there is no room to owe a stop for, and lose none on a restart", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        // Full: as many machines owed a stop as are kept, each a start of unknown outcome.
        const owed = fileOwedStops(dir);
        for (let each = 0; each < OWED_MOST; each += 1)
          owed.add({
            origin: ORIGIN,
            name: `worker-${each.toString(16).padStart(10, "0")}`,
            since: 0,
            unsettled: true,
            start: true,
            attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
          });
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed,
          starting: new Set(),
        });
        // One more is refused, not started where nothing could give it back.
        const started = yield* source.start({ name: NAME, orchestrator: "o", title: "One more" });
        expect(started.kind).toBe("refused");
        expect(app.calls).toEqual([]);
        // Restarted: every machine owed a stop is still owed one.
        expect(fileOwedStops(dir).list()).toHaveLength(OWED_MOST);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("read back every owing past the most, and admit no start until they drain", () =>
    Effect.gen(function* () {
      const app = fakeApp({ answer: () => ({ status: 202, body: {} }) });
      const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
      try {
        const owed = fileOwedStops(dir);
        for (let each = 0; each < OWED_MOST + 20; each += 1)
          owed.add({
            origin: ORIGIN,
            name: `worker-${each.toString(16).padStart(10, "0")}`,
            since: 0,
            attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
          });
        const kept = fileOwedStops(dir);
        expect(kept.list()).toHaveLength(OWED_MOST + 20);
        const source = signedInSource(SERVER, {
          port: bridgeWorkerMachines(app.port),
          hosts: unregistered,
          owed: kept,
          starting: new Set(),
        });
        expect((yield* source.start({ name: NAME, orchestrator: "o", title: "More" })).kind).toBe(
          "refused",
        );
        expect(app.calls).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it("keep only the holds whose time is not up, however many passes asked again", () => {
    let clock = 1_700_000_000_000;
    const owed = memoryOwedStops(
      [],
      () => true,
      () => clock,
    );
    // Thirty-two machines owed a stop, asked every ten minutes while no stop is answered.
    for (let pass = 0; pass < 150; pass += 1) {
      for (let each = 0; each < 32; each += 1)
        owed.holds.hold(
          ORIGIN,
          `worker-${each.toString(16).padStart(10, "0")}`,
          stopHoldUntil(clock),
        );
      clock += 10 * 60_000;
    }
    // None of them can still act there by now: none is kept, and what is written stays small.
    expect(owed.heldList()).toHaveLength(0);
    owed.holds.hold(ORIGIN, NAME, stopHoldUntil(clock));
    expect(owed.heldList()).toHaveLength(1);
  });

  it("keep the owings of a file grown past its bound with holds long over, and shrink it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      // As the file was left before holds were pruned: two owings and thousands of old holds.
      const file = join(dir, "remote-access", "worker-machine-stops.json");
      mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
      const holds = Array.from({ length: 8_000 }, (_, each) => ({
        id: `old-${each}`,
        origin: ORIGIN,
        name: NAME,
        until: 1,
      }));
      const owings = [NAME, "worker-aaaaaaaaaa"].map((name) => ({
        origin: ORIGIN,
        name,
        since: 1,
      }));
      writeFileSync(file, JSON.stringify({ version: 1, owed: owings, holds }), { mode: 0o600 });
      expect(statSync(file).size).toBeGreaterThan(STOPS_FILE_MOST);
      const owed = fileOwedStops(dir);
      // Read all the same: every stop still owed is kept.
      expect(owed.list().map((each) => each.name)).toEqual([NAME, "worker-aaaaaaaaaa"]);
      // Written back with only what still holds, well within what is read back.
      owed.remove("worker-aaaaaaaaaa");
      expect(statSync(file).size).toBeLessThan(STOPS_FILE_MOST);
      expect(
        fileOwedStops(dir)
          .list()
          .map((each) => each.name),
      ).toEqual([NAME]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("set aside a file it can't read, never write over it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      const file = join(dir, "remote-access", "worker-machine-stops.json");
      mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
      writeFileSync(file, "{ not json", { mode: 0o600 });
      fileOwedStops(dir).add({ origin: ORIGIN, name: NAME, since: 1 });
      // What it held is kept beside the new one, for a person to read.
      const aside = readdirSync(join(dir, "remote-access")).filter((each) =>
        each.startsWith("worker-machine-stops.json.unreadable-"),
      );
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(dir, "remote-access", aside[0]!), "utf8")).toBe("{ not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write no more than can be read back, so a restart keeps what was written", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      // Owings with origins long enough that all of them would be past what is read back.
      const origin = `https://${"a".repeat(3_000)}.example.test`;
      const owed = fileOwedStops(dir);
      for (let each = 0; each < OWED_MOST; each += 1)
        owed.add({
          origin,
          name: `worker-${each.toString(16).padStart(10, "0")}`,
          since: 1_700_000_000_000,
          attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
        });
      // Each write that would go past it is refused; what was written last is still read.
      expect(fileOwedStops(dir).list().length).toBeGreaterThan(100);
      // And a stop whose hold can't be written down isn't sent.
      expect(owed.holds.hold(origin, NAME, stopHoldUntil(Date.now()))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keep every owing across a restart, a full list with long origins included", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-owed-"));
    try {
      const origin = `https://${"a".repeat(180)}.example.test`;
      const owed = fileOwedStops(dir);
      for (let each = 0; each < OWED_MOST; each += 1)
        owed.add({
          origin,
          name: `worker-${each.toString(16).padStart(10, "0")}`,
          since: 1_700_000_000_000,
          unsettled: true,
          start: true,
          attempt: `00000000-0000-4000-8000-${each.toString(16).padStart(12, "0")}`,
        });
      expect(fileOwedStops(dir).list()).toHaveLength(OWED_MOST);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hold a name no longer than a stop can act, though the clock stepped back since", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-held-back-"));
    try {
      // Written before the clock stepped back an hour: the hold reads an hour too far ahead.
      mkdirSync(join(dir, "remote-access"), { mode: 0o700 });
      const now = Date.now();
      writeFileSync(
        join(dir, "remote-access", "worker-machine-stops.json"),
        JSON.stringify({
          version: 1,
          owed: [],
          holds: [{ id: "h-1", origin: ORIGIN, name: NAME, until: now + 60 * 60_000 }],
        }),
        { mode: 0o600 },
      );
      const owed = fileOwedStops(dir, () => now);
      // No start of the name waits past what a stop sent now could hold it for.
      expect(owed.holds.until(ORIGIN, NAME, now)).toBe(now + STOP_HOLD_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
