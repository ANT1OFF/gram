import { describe, expect, it } from "@effect/vitest";
import type { HostId, MachineState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { sendQueuedOnJoin } from "./machine-events.ts";

const machine = (id: string, online: boolean): MachineState => ({
  id: id as HostId,
  name: id,
  kind: "provisioned",
  ...(online ? { onlineSince: 1 } : {}),
});

describe("sendQueuedOnJoin", () => {
  it.effect(
    "sends the queues of a machine that comes online, once, and not of one already on",
    () =>
      Effect.gen(function* () {
        let states: ReadonlyArray<MachineState> = [machine("a", true), machine("b", false)];
        const listeners = new Set<() => void>();
        const sent: Array<string> = [];
        yield* sendQueuedOnJoin(
          { sendQueuedOn: (id) => Effect.sync(() => void sent.push(id)) },
          {
            states: () => states,
            watch: (listener) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
        );
        const change = (next: ReadonlyArray<MachineState>) =>
          Effect.gen(function* () {
            states = next;
            for (const listener of listeners) listener();
            yield* Effect.yieldNow;
          });
        yield* change([machine("a", true), machine("b", false)]);
        expect(sent).toEqual([]);
        yield* change([machine("a", true), machine("b", true)]);
        yield* change([machine("a", true), machine("b", true)]);
        expect(sent).toEqual(["b"]);
        yield* change([machine("a", false), machine("b", true)]);
        yield* change([machine("a", true), machine("b", true)]);
        expect(sent).toEqual(["b", "a"]);
      }).pipe(Effect.scoped),
  );
});
