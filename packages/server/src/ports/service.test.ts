import { describe, expect, it } from "@effect/vitest";
import type { ServerEvent, TerminalId, ThreadId } from "@gram/contracts";
import { Proc } from "@gram/git";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { EventHub, type EventHubShape } from "../events/event-hub.ts";
import { AppActivity } from "../git/activity.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { ProcessRoots, ThreadPorts, type PortScan } from "./service.ts";

const t1 = "t1" as ThreadId;
const t2 = "t2" as ThreadId;

const harness = (interval: Duration.Input = "1 hour") => {
  const published: Array<ServerEvent> = [];
  let scan: PortScan | "fail" = { listening: new Map(), children: new Map() };
  let scans = 0;
  const agentPids: Array<readonly [ThreadId, number]> = [];
  const layer = ThreadPorts.layerWith({
    interval,
    scan: Effect.suspend(() => {
      scans++;
      return scan === "fail" ? Effect.fail(new Error("lsof failed")) : Effect.succeed(scan);
    }),
  }).pipe(
    Layer.provideMerge(ProcessRoots.layer),
    Layer.provide(
      Layer.succeed(EventHub)({
        publish: (event) => Effect.sync(() => void published.push(event)),
      } as EventHubShape),
    ),
    Layer.provide(
      Layer.succeed(ThreadRuntimes)({
        processIds: Effect.sync(() => [...agentPids]),
      } as unknown as ThreadRuntimesShape),
    ),
    Layer.provide(Layer.succeed(Proc)({ run: () => Effect.die("no real processes") })),
  );
  return {
    layer,
    published,
    agentPids,
    setScan: (next: PortScan | "fail") => void (scan = next),
    scans: () => scans,
  };
};

/** zsh (100) running `pnpm dev` (300), as `ps` sees it with `tpgid` the terminal's foreground. */
const scanWith = (tpgid: number): PortScan => ({
  listening: new Map(),
  children: new Map([[100, [300]]]),
  processes: new Map([
    [100, { pid: 100, ppid: 1, pgid: 100, tpgid, command: "-zsh" }],
    [300, { pid: 300, ppid: 100, pgid: 300, tpgid, command: "node /opt/bin/pnpm dev" }],
  ]),
});

describe("ThreadPorts", () => {
  it.effect("rests the periodic scan while no window shows, and scans as one comes back", () => {
    const h = harness("5 seconds");
    return Effect.gen(function* () {
      const roots = yield* ProcessRoots;
      const activity = yield* AppActivity;
      roots.add(t1, 100);
      yield* TestClock.adjust("5 seconds");
      const shown = h.scans();
      expect(shown).toBeGreaterThan(0);

      yield* activity.setWindows([{ visible: false, focused: false }]);
      yield* TestClock.adjust("5 seconds");
      const hidden = h.scans();
      // An hour hidden: 720 scans at the 5 s cadence before, none now.
      yield* TestClock.adjust("1 hour");
      expect(h.scans()).toBe(hidden);

      yield* activity.setWindows([{ visible: true, focused: true }]);
      yield* Effect.yieldNow;
      expect(h.scans()).toBe(hidden + 1);
    }).pipe(Effect.provide(h.layer.pipe(Layer.provideMerge(AppActivity.layer))));
  });

  it.effect("publishes each thread's ports when they change, and clears them when roots go", () => {
    const h = harness();
    return Effect.gen(function* () {
      const ports = yield* ThreadPorts;
      const roots = yield* ProcessRoots;
      expect(h.scans()).toBe(0);

      roots.add(t1, 100);
      h.agentPids.push([t2, 200]);
      h.setScan({
        listening: new Map([
          [101, [5173]],
          [200, [3000, 3001]],
        ]),
        children: new Map([[100, [101]]]),
      });
      yield* ports.refresh;
      // Agent roots are merged before terminal roots, so t2 publishes first.
      expect(h.published).toEqual([
        { type: "thread.ports", threadId: t2, ports: [3000, 3001] },
        { type: "thread.ports", threadId: t1, ports: [5173] },
      ]);
      expect(ports.portsOf(t1)).toEqual([5173]);

      yield* ports.refresh;
      expect(h.published).toHaveLength(2);

      h.setScan("fail");
      yield* ports.refresh;
      expect(h.published).toHaveLength(2);
      expect(ports.portsOf(t2)).toEqual([3000, 3001]);

      roots.remove(100);
      h.agentPids.length = 0;
      const scansBefore = h.scans();
      yield* ports.refresh;
      expect(h.scans()).toBe(scansBefore);
      expect(h.published.slice(2)).toEqual([
        { type: "thread.ports", threadId: t2, ports: [] },
        { type: "thread.ports", threadId: t1, ports: [] },
      ]);
      expect(ports.portsOf(t1)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("publishes what runs in each terminal's foreground, and when it stops", () => {
    const h = harness();
    const term = "term-1" as TerminalId;
    return Effect.gen(function* () {
      const ports = yield* ThreadPorts;
      const roots = yield* ProcessRoots;
      // Past the layer's own first scan, which runs as soon as the test yields.
      yield* TestClock.adjust(5000);
      roots.add(t1, 100, term);
      h.setScan(scanWith(300));
      yield* ports.refresh;
      const busy = [{ terminalId: term, pid: 300, command: "pnpm dev", startedAt: 5000 }];
      expect(h.published.filter((e) => e.type === "thread.terminalProcesses")).toEqual([
        { type: "thread.terminalProcesses", threadId: t1, processes: busy },
      ]);
      expect(ports.terminalProcessesOf(t1)).toEqual(busy);

      // Still running on the next scan: nothing new to say, and it keeps its first sighting.
      yield* TestClock.adjust(5000);
      yield* ports.refresh;
      expect(h.published.filter((e) => e.type === "thread.terminalProcesses")).toHaveLength(1);

      // A key on the command line is scrubbed before the line is clipped, not after.
      const key = `sk-${"x".repeat(40)}`;
      h.setScan({
        ...scanWith(300),
        processes: new Map([
          [100, { pid: 100, ppid: 1, pgid: 100, tpgid: 300, command: "-zsh" }],
          [
            300,
            {
              pid: 300,
              ppid: 100,
              pgid: 300,
              tpgid: 300,
              command: `curl ${"a".repeat(185)} ${key}`,
            },
          ],
        ]),
      });
      yield* ports.refresh;
      expect(ports.terminalProcessesOf(t1)[0]?.command).not.toContain("sk-");

      // Back at the prompt.
      h.setScan(scanWith(100));
      yield* ports.refresh;
      expect(h.published.filter((e) => e.type === "thread.terminalProcesses").at(-1)).toEqual({
        type: "thread.terminalProcesses",
        threadId: t1,
        processes: [],
      });
      expect(ports.terminalProcessesOf(t1)).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reads busy terminals from a fresh scan, and says so when it can't", () => {
    const h = harness();
    return Effect.gen(function* () {
      const ports = yield* ThreadPorts;
      const roots = yield* ProcessRoots;
      yield* TestClock.adjust(5000);
      expect(yield* ports.busyTerminalsNow).toEqual([]);
      const before = h.scans();

      roots.add(t1, 100, "term-1" as TerminalId);
      h.setScan(scanWith(300));
      // No periodic scan has seen the command yet; this one does.
      expect(ports.terminalProcessesOf(t1)).toEqual([]);
      expect(yield* ports.busyTerminalsNow).toEqual([t1]);
      expect(h.scans()).toBe(before + 1);

      h.setScan(scanWith(100));
      expect(yield* ports.busyTerminalsNow).toEqual([]);
      h.setScan("fail");
      expect(yield* ports.busyTerminalsNow).toBeUndefined();
      h.setScan({ listening: new Map(), children: new Map() });
      expect(yield* ports.busyTerminalsNow).toBeUndefined();
    }).pipe(Effect.provide(h.layer));
  });
});
