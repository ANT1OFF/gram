import { type HostId, type Thread, ThreadId, ThreadNotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { bindAppTools } from "../app-tools/registry.ts";
import { callerPerson, forThread, lineageOwner, RoutedFor } from "../host/ownership.ts";
import { describe, expect, it } from "vitest";
import {
  headlessPlacement,
  machineFor,
  NO_MACHINE_JOINED,
  NOT_YOUR_MACHINE,
  placeRequest,
  START_A_MACHINE,
  type PlaceableMachine,
} from "../host/headless.ts";
import { embedFromEnv, scrubEmbedSecrets } from "./config.ts";
import { makeOnDemandHosts, ownMachine, parseStart, statusFor, takeProgress } from "./on-demand.ts";
import { ActingPerson } from "./person.ts";

const id = (value: string) => value as HostId;
const TOKEN = "t".repeat(40);
const machine = (
  over: Omit<Partial<PlaceableMachine>, "id"> & { id: string },
): PlaceableMachine => ({
  name: over.id,
  confirmed: true,
  joinedAt: 1,
  onlineSince: 10,
  ...over,
  id: id(over.id),
});

describe("hosts provisioned on demand: placement", () => {
  const ada = machine({ id: "m-ada", owner: "ada", onDemand: "personal" });
  const grace = machine({ id: "m-grace", owner: "grace", onDemand: "personal" });
  const shared = machine({ id: "m-shared", joinedAt: 5 });

  it("places a person's work on their own machine, and never on another person's", () => {
    expect(machineFor([grace, ada, shared], "ada", true)).toEqual({ id: "m-ada" });
    expect(machineFor([grace, shared], "ada", true)).toEqual({ id: "m-shared" });
    // Someone else's machine is nobody's default.
    expect(machineFor([grace], "ada", true)).toEqual({ error: START_A_MACHINE });
    expect(machineFor([grace], undefined, true)).toEqual({ error: NO_MACHINE_JOINED });
  });

  it("tells a person to start one only where hosts are provisioned on demand", () => {
    expect(machineFor([], "ada", true)).toEqual({ error: START_A_MACHINE });
    expect(machineFor([], "ada", false)).toEqual({ error: NO_MACHINE_JOINED });
  });

  it("skips a person's machine that is offline, or a thread's host", () => {
    const offline = machine({
      id: "m-off",
      owner: "ada",
      onDemand: "personal",
      onlineSince: undefined,
    });
    const thread = machine({ id: "m-thread", owner: "ada", onDemand: "thread" });
    expect(machineFor([offline, thread], "ada", true)).toEqual({ error: START_A_MACHINE });
  });

  it("refuses work that names another person's machine", async () => {
    const placement = headlessPlacement({ list: () => [ada, grace, shared] as never }, true);
    const place = (person: string | undefined, hostId: string) =>
      Effect.runPromise(
        placeRequest(placement, { kind: "newWorktree", hostId: id(hostId) } as never).pipe(
          Effect.provideService(ActingPerson, person),
          Effect.match({ onFailure: (error) => error.message, onSuccess: () => "placed" }),
        ),
      );
    expect(await place("ada", "m-ada")).toBe("placed");
    expect(await place("ada", "m-grace")).toBe(NOT_YOUR_MACHINE);
    expect(await place(undefined, "m-grace")).toBe(NOT_YOUR_MACHINE);
    expect(await place("ada", "m-shared")).toBe("placed");
  });
});

const adaBox = machine({ id: "m-ada", owner: "ada", onDemand: "personal" });
const sharedBox = machine({ id: "m-shared", joinedAt: 5 });
const ownerOf = (hostId: HostId) => (hostId === adaBox.id ? "ada" : undefined);
const stored = (threadId: string, hostId: string | undefined, spawnedBy?: string) =>
  ({
    id: ThreadId.make(threadId),
    checkout: {
      kind: "worktree",
      path: `/w/${threadId}`,
      ...(hostId === undefined ? {} : { hostId }),
    },
    ...(spawnedBy === undefined
      ? {}
      : { spawnedBy: { threadId: ThreadId.make(spawnedBy), feature: "f" } }),
  }) as unknown as Thread;
const threads = [
  stored("ada-orchestrator", "m-ada"),
  stored("ada-worker", "m-shared", "ada-orchestrator"),
  stored("shared-orchestrator", "m-shared"),
  stored("loop-a", undefined, "loop-b"),
  stored("loop-b", undefined, "loop-a"),
];
const getThread = (threadId: ThreadId) => {
  const found = threads.find((thread) => thread.id === threadId);
  return found === undefined
    ? Effect.fail(new ThreadNotFound({ threadId }))
    : Effect.succeed(found);
};
const outcome = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: (a) => a })),
  );
const ownerAt = (threadId: string) =>
  Effect.runPromise(lineageOwner(getThread, ownerOf, ThreadId.make(threadId)));
const asThread = (threadId: string) => forThread(getThread, ownerOf, ThreadId.make(threadId));
const inGracesRpc = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.provideService(ActingPerson, "grace"),
    Effect.provideService(RoutedFor, { person: "grace" }),
  );

describe("hosts provisioned on demand: a background worker's person", () => {
  it("is the owner of the machine its thread is on, else its spawner's, and never made up", async () => {
    expect(await ownerAt("ada-orchestrator")).toBe("ada");
    expect(await ownerAt("ada-worker")).toBe("ada");
    expect(await ownerAt("shared-orchestrator")).toBeUndefined();
    expect(await ownerAt("loop-a")).toBeUndefined();
    expect(await ownerAt("not-stored")).toBeUndefined();
  });

  // The review's case: an orchestrator on Ada's machine spawns from its tool, where no RPC of hers
  // is running. Without her, the spawn found no machine, and naming hers was refused.
  it("places its spawn on its person's machine, with no one signed in on the call", async () => {
    const placement = headlessPlacement({ list: () => [adaBox] as never }, true);
    expect(await outcome(placement.machine)).toBe(NO_MACHINE_JOINED);
    expect(await outcome(asThread("ada-orchestrator")(placement.machine))).toBe("m-ada");
    const named = { kind: "newWorktree", hostId: id("m-ada") } as never;
    expect(await outcome(asThread("ada-orchestrator")(placeRequest(placement, named)))).toEqual(
      named,
    );
    expect(await outcome(asThread("ada-worker")(placeRequest(placement, named)))).toEqual(named);
    // A thread on no one's machine is no one's, whoever's RPC is running.
    const graces = Effect.provideService(ActingPerson, "grace");
    expect(
      await outcome(graces(asThread("shared-orchestrator")(placeRequest(placement, named)))),
    ).toBe(NOT_YOUR_MACHINE);
    // A shared machine beside it takes no work of Ada's thread that names none.
    const both = headlessPlacement({ list: () => [adaBox, sharedBox] as never }, true);
    expect(await outcome(asThread("ada-worker")(both.machine))).toBe("m-ada");
  });

  it("runs an agent's tool call as its thread's lineage, not the RPC that began the turn", async () => {
    const tool = defineAppTool({
      descriptor: { name: "whose", class: "self", description: "Who this call is for." },
      input: Schema.Struct({ owner: Schema.optionalKey(Schema.String) }),
      handle: () => callerPerson,
    });
    const [bound] = bindAppTools([tool], ThreadId.make("ada-worker"), undefined, undefined, (t) =>
      lineageOwner(getThread, ownerOf, t),
    );
    // What the input says of an owner is never read.
    expect(await Effect.runPromise(inGracesRpc(bound!.run({ owner: "grace" })))).toBe("ada");
    const [unbound] = bindAppTools([tool], ThreadId.make("shared-orchestrator"));
    expect(await Effect.runPromise(inGracesRpc(unbound!.run({})))).toBeUndefined();
  });
});

describe("hosts provisioned on demand: requests and progress", () => {
  it("takes a short list of repositories, or none", () => {
    expect(parseStart("")).toEqual({ repositories: [] });
    expect(parseStart('{"repositories":["acme/web","acme/web","acme/api"]}')).toEqual({
      repositories: ["acme/web", "acme/api"],
    });
    expect(parseStart('{"repositories":["../etc"]}')).toEqual(expect.any(String));
    expect(parseStart('{"repositories":["acme/.."]}')).toEqual(expect.any(String));
    expect(parseStart('{"repositories":"acme/web"}')).toEqual(expect.any(String));
    expect(parseStart("[]")).toEqual(expect.any(String));
    expect(parseStart("{")).toEqual(expect.any(String));
  });

  it("shows a person their own machine and progress, and no one else's", () => {
    const hosts = makeOnDemandHosts({ url: "https://provider.test" });
    const machines = [
      { id: "m-ada", name: "ada-1", owner: "ada", onDemand: "personal" as const, onlineSince: 5 },
      { id: "m-grace", name: "grace-1", owner: "grace", onDemand: "personal" as const },
    ];
    expect(ownMachine(machines, "ada")?.id).toBe("m-ada");
    expect(statusFor(hosts, machines, "ada")).toEqual({
      available: true,
      machine: { id: "m-ada", name: "ada-1", online: true },
    });
    expect(statusFor(hosts, machines, "someone")).toEqual({ available: true });
  });

  it("takes progress only for a start it asked for, for that person", () => {
    const hosts = makeOnDemandHosts({ url: "https://provider.test" });
    hosts.progress.set("ada", { hostKey: "personal:ws:ada", phase: "starting", at: 1 });
    expect(
      takeProgress(hosts, { owner: "grace", hostKey: "personal:ws:ada", phase: "ready" }, 2).status,
    ).toBe(404);
    expect(takeProgress(hosts, { owner: "ada", hostKey: "other", phase: "ready" }, 2).status).toBe(
      404,
    );
    expect(
      takeProgress(hosts, { owner: "ada", hostKey: "personal:ws:ada", phase: "done" }, 2).status,
    ).toBe(400);
    expect(
      takeProgress(
        hosts,
        {
          owner: "ada",
          hostKey: "personal:ws:ada",
          phase: "booting",
          step: "Disk ready",
          message: "a\nb",
        },
        2,
      ),
    ).toEqual({ status: 200, body: { taken: true } });
    // A line with a newline is not kept; the rest is.
    expect(hosts.progress.get("ada")).toEqual({
      hostKey: "personal:ws:ada",
      phase: "booting",
      step: "Disk ready",
      at: 2,
    });
  });
});

describe("hosts provisioned on demand: configuration", () => {
  it("reads the provider, which needs the inbound token for its progress", () => {
    expect(
      embedFromEnv({
        GRAM_EMBED_TOKEN: TOKEN,
        GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts/",
        GRAM_HOST_PROVIDER_TOKEN: TOKEN,
      })?.hostProvider,
    ).toEqual({ url: "https://cell-manager.internal/hosts", token: TOKEN });
    expect(() =>
      embedFromEnv({ GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts" }),
    ).toThrow(/GRAM_EMBED_TOKEN/);
  });

  it("keeps the provider's token from everything the server starts", () => {
    const env: Record<string, string | undefined> = {
      GRAM_HOST_PROVIDER_TOKEN: TOKEN,
      GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts",
    };
    scrubEmbedSecrets(env);
    expect(env).toEqual({ GRAM_HOST_PROVIDER_URL: "https://cell-manager.internal/hosts" });
  });
});
