import { HostId, LOCAL_HOST_ID } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { type WorkerHost, WorkerHosts } from "./worker-host.ts";

const Local = WorkerHosts.layerLocal.pipe(
  Layer.provideMerge(Layer.mergeAll(AgentHosts.layerNone, CheckoutService.layerNoGit)),
);

describe("WorkerHosts", () => {
  it.effect("the local host is this machine's agents and checkouts, under `local`", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      expect(hosts.local.id).toBe(LOCAL_HOST_ID);
      expect(hosts.local.sessions).toBe(yield* AgentHosts);
      expect(hosts.local.checkouts).toBe(yield* CheckoutService);
      expect(yield* hosts.get(LOCAL_HOST_ID)).toBe(hosts.local);
    }).pipe(Effect.provide(Local)),
  );

  it.effect("a record with no host is on this machine", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      expect(yield* hosts.of({})).toBe(hosts.local);
      expect(yield* hosts.of({ hostId: LOCAL_HOST_ID })).toBe(hosts.local);
    }).pipe(Effect.provide(Local)),
  );

  it.effect("a machine that isn't paired is unavailable, never this one", () =>
    Effect.gen(function* () {
      const hosts = yield* WorkerHosts;
      const error = yield* hosts.of({ hostId: HostId.make("tower") }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "HostUnavailable", hostId: "tower" });
    }).pipe(Effect.provide(Local)),
  );

  it.effect("finds a paired host by its id", () =>
    Effect.gen(function* () {
      const local = (yield* WorkerHosts).local;
      const tower: WorkerHost = { ...local, id: HostId.make("tower") };
      const hosts = WorkerHosts.fromHosts(local, [tower]);
      expect(yield* hosts.of({ hostId: tower.id })).toBe(tower);
      expect(yield* hosts.get(LOCAL_HOST_ID)).toBe(local);
    }).pipe(Effect.provide(Local)),
  );
});
