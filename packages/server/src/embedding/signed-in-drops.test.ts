import { describe, expect, it } from "@effect/vitest";
import { HostId, type MachineProviderWord } from "@gram/contracts";
import * as Effect from "effect/Effect";

import { parseMachineStatus, providerWordOf } from "./signed-in-calls.ts";
import { askOnDrop } from "./signed-in-drops.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";

const AT = Date.parse("2026-11-22T16:41:00Z");

describe("what a server's status answer says of a machine, for its mark", () => {
  it("carries the phase, why it stopped and since when, in Gram's own words", () => {
    const status = parseMachineStatus({
      phase: "starting",
      cause: "reclaimed",
      since: "2026-11-22T16:41:00Z",
      message: "It is starting.",
    });
    expect(providerWordOf(status, AT + 1)).toEqual({
      phase: "starting",
      cause: "reclaimed",
      since: AT,
      message: "It is starting.",
      at: AT + 1,
    });
    expect(providerWordOf(parseMachineStatus({ phase: "stopped", since: AT }), 1)).toEqual({
      phase: "stopped",
      since: AT,
      at: 1,
    });
  });

  it("drops a cause or time it can't read, and says nothing of a phase it doesn't know", () => {
    expect(
      providerWordOf(parseMachineStatus({ phase: "failed", cause: "gremlins", since: "soon" }), 1),
    ).toEqual({ phase: "failed", at: 1 });
    expect(providerWordOf(parseMachineStatus({ phase: "hibernating" }), 1)).toBeUndefined();
    expect(providerWordOf(parseMachineStatus("not json"), 1)).toBeUndefined();
  });
});

describe("a relayed machine that drops", () => {
  it.live("has its server asked what became of it, once, and the answer kept for its mark", () =>
    Effect.gen(function* () {
      const machine = {
        id: "m-1",
        name: "worker-827d7eaf1e",
        via: "https://cloud.example.test",
        onDemand: "worker" as const,
        onlineSince: 1 as number | undefined,
      };
      const watchers = new Set<() => void>();
      const said: Array<[HostId, MachineProviderWord | undefined]> = [];
      const asked: Array<string> = [];
      const hosts = {
        list: () => [machine],
        watch: (listener: () => void) => {
          watchers.add(listener);
          return () => watchers.delete(listener);
        },
        providerSaid: (id: HostId, word: MachineProviderWord | undefined) => said.push([id, word]),
      } as never;
      const port = {
        call: (_origin: string, call: string, body: { name: string }) =>
          Effect.sync(() => {
            asked.push(`${call} ${body.name}`);
            return { ok: true, status: 200, body: { phase: "stopped", cause: "reclaimed" } };
          }),
      } as unknown as WorkerMachinePortShape;
      yield* askOnDrop(port, hosts, 0);
      // Still online: nothing is asked.
      for (const watcher of watchers) watcher();
      yield* Effect.sleep("20 millis");
      expect(asked).toEqual([]);
      machine.onlineSince = undefined;
      for (const watcher of watchers) watcher();
      for (const watcher of watchers) watcher();
      yield* Effect.sleep("50 millis");
      expect(asked).toEqual(["status worker-827d7eaf1e"]);
      expect(said).toEqual([
        [HostId.make("m-1"), { phase: "stopped", cause: "reclaimed", at: expect.any(Number) }],
      ]);
    }).pipe(Effect.scoped),
  );
});
