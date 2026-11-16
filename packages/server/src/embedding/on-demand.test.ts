import { type HostId, type Thread, ThreadId, ThreadNotFound } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { bindAppTools } from "../app-tools/registry.ts";
import {
  asServerWork,
  asThreadOwner,
  currentCaller,
  mayReach,
  MOVE_CHANGES_OWNER,
  NOBODY,
  ownersOf,
  RoutedFor,
  sameOwner,
  callerPerson,
} from "../host/ownership.ts";
import { ownedRuntimes } from "../runtime/owned-runtimes.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
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
import {
  choicesFor,
  makeOnDemandHosts,
  ownMachine,
  parseChoices,
  parsePreferences,
  parseStart,
  READY_GRACE_MS,
  statusFor,
  takeProgress,
} from "./on-demand.ts";
import { ActingPerson } from "./person.ts";

const id = (value: string) => value as HostId;
/** A place on `hostId`, as a checkout names its machine. */
const at = (hostId: string) => ({ hostId: id(hostId) });
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

  it("places a person's work on their own machine alone, never on another person's or a shared one", () => {
    expect(machineFor([grace, ada, shared], "ada", true)).toEqual({ id: "m-ada" });
    // With none of their own, they are told to start one: no other machine takes their work.
    expect(machineFor([grace, shared], "ada", true)).toEqual({ error: START_A_MACHINE });
    expect(machineFor([grace], "ada", true)).toEqual({ error: START_A_MACHINE });
    // Work for nobody in particular (the server's own) still takes the shared machine.
    expect(machineFor([grace, shared], undefined, true)).toEqual({ id: "m-shared" });
    expect(machineFor([grace], undefined, true)).toEqual({ error: NO_MACHINE_JOINED });
  });

  it("never makes a host started for the threads placed on it anyone's default", () => {
    // As an embedder registers a host for one run: no owner, kind `thread`.
    const run = machine({ id: "m-run", onDemand: "thread", owner: undefined, joinedAt: 0 });
    expect(machineFor([run, shared], undefined, true)).toEqual({ id: "m-shared" });
    expect(machineFor([run], undefined, true)).toEqual({ error: NO_MACHINE_JOINED });
    expect(machineFor([run], undefined, false)).toEqual({ error: NO_MACHINE_JOINED });
    expect(machineFor([run], "ada", true)).toEqual({ error: START_A_MACHINE });
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
// An orchestration has one owner (`host/ownership.ts`): Ada's worker is on her machine too.
const threads = [
  stored("ada-orchestrator", "m-ada"),
  stored("ada-worker", "m-ada", "ada-orchestrator"),
  stored("shared-orchestrator", "m-shared"),
  stored("shared-worker", undefined, "ada-orchestrator"),
  // Started before their machines: on none yet, each by the person named.
  { ...stored("waiting-ada", "awaited"), awaitingMachine: { since: 0, startedBy: "ada" } },
  { ...stored("waiting-grace", "awaited"), awaitingMachine: { since: 0, startedBy: "grace" } },
  { ...stored("waiting-anyone", "awaited"), awaitingMachine: { since: 0 } },
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
  Effect.runPromise(asThreadOwner(getThread, ownerOf, ThreadId.make(threadId))(callerPerson));
const asThread = (threadId: string) => asThreadOwner(getThread, ownerOf, ThreadId.make(threadId));
const inGracesRpc = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.provideService(ActingPerson, "grace"),
    Effect.provideService(RoutedFor, { person: "grace" }),
  );

describe("hosts provisioned on demand: a background worker's person", () => {
  it("is the owner of the machine its own thread is on, inherited from no one", async () => {
    expect(await ownerAt("ada-orchestrator")).toBe("ada");
    expect(await ownerAt("ada-worker")).toBe("ada");
    expect(await ownerAt("shared-orchestrator")).toBeUndefined();
    // Spawned by Ada's orchestrator, but on no one's machine: no one's.
    expect(await ownerAt("shared-worker")).toBeUndefined();
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

  it("runs an agent's tool call as its thread's owner, not the RPC that began the turn", async () => {
    const tool = defineAppTool({
      descriptor: { name: "whose", class: "self", description: "Who this call is for." },
      input: Schema.Struct({ owner: Schema.optionalKey(Schema.String) }),
      handle: () => callerPerson,
    });
    const [bound] = bindAppTools([tool], ThreadId.make("ada-worker"), undefined, undefined, (t) =>
      asThreadOwner(getThread, ownerOf, t)(Effect.map(callerPerson, (person) => ({ person }))),
    );
    // What the input says of an owner is never read.
    expect(await Effect.runPromise(inGracesRpc(bound!.run({ owner: "grace" })))).toBe("ada");
    const [unbound] = bindAppTools([tool], ThreadId.make("shared-orchestrator"));
    expect(await Effect.runPromise(inGracesRpc(unbound!.run({})))).toBeUndefined();
  });
});

describe("hosts provisioned on demand: requests and progress", () => {
  it("takes a short list of repositories, or none", () => {
    expect(parseStart("")).toEqual({ repositories: [], choices: {} });
    expect(parseStart('{"repositories":["acme/web","acme/web","acme/api"]}')).toEqual({
      repositories: ["acme/web", "acme/api"],
      choices: {},
    });
    expect(parseStart('{"repositories":["../etc"]}')).toEqual(expect.any(String));
    expect(parseStart('{"repositories":["acme/.."]}')).toEqual(expect.any(String));
    expect(parseStart('{"repositories":"acme/web"}')).toEqual(expect.any(String));
    expect(parseStart("[]")).toEqual(expect.any(String));
    expect(parseStart("{")).toEqual(expect.any(String));
  });

  it("takes what a person picked, by short ids only", () => {
    expect(parseStart('{"choices":{"size":"large","architecture":"arm64"}}')).toEqual({
      repositories: [],
      choices: { size: "large", architecture: "arm64" },
    });
    expect(parseStart('{"choices":{"size":"Large; rm -rf"}}')).toEqual(expect.any(String));
    expect(parseStart('{"choices":{"../x":"a"}}')).toEqual(expect.any(String));
    expect(parseStart('{"choices":["size"]}')).toEqual(expect.any(String));
    expect(parseStart('{"choices":{"size":3}}')).toEqual(expect.any(String));
  });

  it("takes a start again with other picks, and keeping them as the person's own", () => {
    expect(parseStart('{"choices":{"isolation":"vm"},"restart":true,"keep":true}')).toEqual({
      repositories: [],
      choices: { isolation: "vm" },
      keep: true,
      restart: true,
    });
    expect(parseStart('{"restart":false}')).toEqual({ repositories: [], choices: {} });
    expect(parseStart('{"keep":"yes"}')).toEqual(expect.any(String));
  });

  it("takes the picks a person keeps as theirs, by short ids only", () => {
    expect(parsePreferences('{"choices":{"size":"medium"}}')).toEqual({
      choices: { size: "medium" },
    });
    expect(parsePreferences("")).toEqual({ choices: {} });
    expect(parsePreferences('{"choices":{"size":"Medium!"}}')).toEqual(expect.any(String));
    expect(parsePreferences("[]")).toEqual(expect.any(String));
  });

  it("reads which pick is the person's own, what the machine has now, and short labels", () => {
    expect(
      parseChoices({
        keeps: true,
        choices: [
          {
            id: "isolation",
            label: "Kind",
            default: "vm",
            fallback: "container",
            current: "container",
            options: [
              { id: "container", label: "Container", short: "Container" },
              { id: "vm", label: "Virtual machine", short: "VM" },
            ],
          },
          {
            id: "size",
            label: "Size",
            default: "small",
            // Not one of its options: left out.
            fallback: "huge",
            current: "huge",
            options: [{ id: "small", label: "Small", short: "a".repeat(25) }],
          },
        ],
      }),
    ).toEqual({
      keeps: true,
      choices: [
        {
          id: "isolation",
          label: "Kind",
          default: "vm",
          fallback: "container",
          current: "container",
          options: [
            { id: "container", label: "Container", available: true, short: "Container" },
            { id: "vm", label: "Virtual machine", available: true, short: "VM" },
          ],
        },
        {
          id: "size",
          label: "Size",
          default: "small",
          options: [{ id: "small", label: "Small", available: true }],
        },
      ],
    });
  });

  it("reads the provider's choices field by field, keeping only those with an option to pick", () => {
    expect(
      parseChoices({
        note: "Acme allows up to Large.",
        choices: [
          {
            id: "size",
            label: "Size",
            default: "xlarge",
            options: [
              { id: "small", label: "Small", detail: "1 CPU · 2 GB" },
              { id: "large", label: "Large", available: true },
              { id: "xlarge", label: "Extra large", available: false, note: "Above the limit" },
              { id: "Bad Id", label: "Nope" },
            ],
          },
          { id: "empty", label: "Nothing", options: [{ id: "x", label: "X", available: false }] },
          { id: "no-options", label: "No options" },
        ],
      }),
    ).toEqual({
      note: "Acme allows up to Large.",
      choices: [
        {
          id: "size",
          label: "Size",
          // The provider's default can't be picked, so the first that can is.
          default: "small",
          options: [
            { id: "small", label: "Small", detail: "1 CPU · 2 GB", available: true },
            { id: "large", label: "Large", available: true },
            { id: "xlarge", label: "Extra large", available: false, note: "Above the limit" },
          ],
        },
      ],
    });
    expect(parseChoices({ choices: [] })).toBeUndefined();
    expect(parseChoices("size")).toBeUndefined();
  });

  it("asks the provider for a person's choices once in a while, and offers none it can't read", async () => {
    const hosts = makeOnDemandHosts({ url: "https://provider.test" });
    hosts.choices.set("ada", {
      at: 1_000,
      value: { choices: [{ id: "size", label: "Size", default: "small", options: [] }] },
    });
    // Still fresh: the provider is not asked.
    expect((await Effect.runPromise(choicesFor(hosts, "ada", 2_000)))?.choices[0]?.id).toBe("size");
    // A provider that can't be reached offers nothing, and that is kept a while too.
    const none = await Effect.runPromise(choicesFor(hosts, "grace", 2_000));
    expect(none).toBeUndefined();
    expect(hosts.choices.get("grace")).toEqual({ at: 2_000 });
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

  it("ends a ready start whose machine went offline or never came, so a new one can be asked for", () => {
    const hosts = makeOnDemandHosts({ url: "https://provider.test" });
    const offline = [{ id: "m-ada", name: "ada-1", owner: "ada", onDemand: "personal" as const }];
    hosts.progress.set("ada", { hostKey: "personal:ws:ada", phase: "ready", at: 1_000 });
    // Just ready, its machine not online yet: still coming.
    expect(statusFor(hosts, offline, "ada", undefined, 1_000 + READY_GRACE_MS).progress).toEqual({
      hostKey: "personal:ws:ada",
      phase: "ready",
      at: 1_000,
    });
    // Long after, with the machine stopped: no start is shown, and none is kept.
    expect(statusFor(hosts, offline, "ada", undefined, 2_000 + READY_GRACE_MS)).toEqual({
      available: true,
      machine: { id: "m-ada", name: "ada-1", online: false },
    });
    expect(hosts.progress.has("ada")).toBe(false);
    // The same with no machine at all.
    hosts.progress.set("ada", { hostKey: "personal:ws:ada", phase: "ready", at: 1_000 });
    expect(statusFor(hosts, [], "ada", undefined, 2_000 + READY_GRACE_MS)).toEqual({
      available: true,
    });
    // A start still under way is kept however long it takes.
    hosts.progress.set("ada", { hostKey: "personal:ws:ada", phase: "booting", at: 1_000 });
    expect(statusFor(hosts, [], "ada", undefined, 10 * READY_GRACE_MS).progress?.phase).toBe(
      "booting",
    );
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

/** Runtimes that record what reached them. */
const recording = () => {
  const reached: Array<string> = [];
  const note =
    (name: string) =>
    (threadId: ThreadId, ..._rest: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        reached.push(`${name}:${threadId}`);
        return undefined as never;
      });
  const runtimes = {
    send: note("send"),
    steer: note("steer"),
    respond: note("respond"),
    moveCheckout: note("moveCheckout"),
    relocate: (threadId: ThreadId, plan: { readonly prepare: Effect.Effect<unknown, unknown> }) =>
      Effect.flatMap(plan.prepare, () =>
        Effect.sync(() => {
          reached.push(`relocate:${threadId}`);
          return undefined as never;
        }),
      ),
    respondMany: (answers: ReadonlyArray<{ threadId: ThreadId; requestId: string }>) =>
      Effect.sync(() =>
        answers.map((each) => {
          reached.push(`respondMany:${each.threadId}`);
          return { threadId: each.threadId, requestId: each.requestId, ok: true };
        }),
      ),
  } as unknown as ThreadRuntimesShape;
  return { reached, owned: ownedRuntimes(runtimes, getThread, ownerOf) };
};
const as =
  (person: string | undefined) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.provideService(effect, RoutedFor, { person });
const adaWorker = ThreadId.make("ada-worker");
const sharedThread = ThreadId.make("shared-orchestrator");
const answer = { kind: "approval", decision: "allow", scope: "once" } as never;

/** A checkout on `hostId`, for a move. */
const onto = (hostId: string) => ({ kind: "main", path: "/w/x", hostId }) as never;

/** The first placement of a thread that waits for its machine, on `hostId`. */
const placing = (hostId: string) => ({
  from: onto("awaited"),
  prepare: Effect.succeed(onto(hostId)),
});

describe("hosts provisioned on demand: what reaches a person's threads", () => {
  // An already running session needs no machine looked up: the delivery itself is checked.
  it("refuses another person's send, steer and answer to a thread on someone's machine", async () => {
    const { reached, owned } = recording();
    for (const call of [
      owned.send(adaWorker, { text: "Grace's" }) as Effect.Effect<unknown, { message: string }>,
      owned.steer(adaWorker, { text: "Grace's" }),
      owned.respond(adaWorker, "r-1" as never, answer),
    ])
      expect(await outcome(as("grace")(call))).toBe(NOT_YOUR_MACHINE);
    const many = await Effect.runPromise(
      as("grace")(
        owned.respondMany([
          { threadId: adaWorker, requestId: "r-1" as never, answer },
          { threadId: sharedThread, requestId: "r-2" as never, answer },
        ]),
      ),
    );
    expect(many).toEqual([
      { threadId: adaWorker, requestId: "r-1", ok: false, error: NOT_YOUR_MACHINE },
      { threadId: sharedThread, requestId: "r-2", ok: true },
    ]);
    expect(reached).toEqual([`respondMany:${sharedThread}`]);
  });

  it("lets the owner, and the server's own work, through", async () => {
    const { reached, owned } = recording();
    await Effect.runPromise(as("ada")(owned.send(adaWorker, { text: "Ada's" })));
    await Effect.runPromise(asServerWork(owned.steer(adaWorker, { text: "the server's" })));
    await Effect.runPromise(as("grace")(owned.send(sharedThread, { text: "anyone's" })));
    expect(reached).toEqual([`send:${adaWorker}`, `steer:${adaWorker}`, `send:${sharedThread}`]);
  });

  // A thread moved onto another machine (an embedder's, when its own is gone) stays its owner's.
  it("moves a thread only onto a machine started for the same person", async () => {
    const { reached, owned } = recording();
    const orchestrator = ThreadId.make("ada-orchestrator");
    await Effect.runPromise(asServerWork(owned.moveCheckout(orchestrator, onto("m-ada"))));
    await Effect.runPromise(asServerWork(owned.moveCheckout(sharedThread, onto("m-shared"))));
    for (const [threadId, hostId] of [
      [orchestrator, "m-shared"],
      [sharedThread, "m-ada"],
    ] as const) {
      const exit = await Effect.runPromiseExit(
        asServerWork(owned.moveCheckout(threadId, onto(hostId))),
      );
      expect(String(exit)).toContain(MOVE_CHANGES_OWNER);
    }
    // And never for someone else, wherever to.
    const refused = await Effect.runPromise(
      as("grace")(owned.moveCheckout(orchestrator, onto("m-ada"))).pipe(Effect.flip),
    );
    expect(refused._tag).toBe("ThreadNotFound");
    expect(reached).toEqual([`moveCheckout:${orchestrator}`, `moveCheckout:${sharedThread}`]);
  });

  // gram#477's move off a machine that is gone: the same floor as `moveCheckout`.
  it("relocates a thread only onto a machine of the same owner, and only for its owner", async () => {
    const { reached, owned } = recording();
    const orchestrator = ThreadId.make("ada-orchestrator");
    const from = onto("m-ada");
    const plan = (hostId: string) => ({ from, prepare: Effect.succeed(onto(hostId)) });
    await Effect.runPromise(asServerWork(owned.relocate(orchestrator, plan("m-ada"))));
    const changed = await Effect.runPromiseExit(
      asServerWork(owned.relocate(orchestrator, plan("m-shared"))),
    );
    expect(String(changed)).toContain(MOVE_CHANGES_OWNER);
    const refused = await Effect.runPromise(
      as("grace")(owned.relocate(orchestrator, plan("m-ada"))).pipe(Effect.flip),
    );
    expect(refused._tag).toBe("ThreadNotFound");
    expect(reached).toEqual([`relocate:${orchestrator}`]);
  });

  // A thread started before its machine has no owner to keep: it has who it was started by.
  it("places a thread that waits for its machine only on its starter's machine, or no one's", async () => {
    const { reached, owned } = recording();
    const plan = placing;
    const ada = ThreadId.make("waiting-ada");
    const grace = ThreadId.make("waiting-grace");
    const anyone = ThreadId.make("waiting-anyone");
    await Effect.runPromise(asServerWork(owned.relocate(ada, plan("m-ada"))));
    await Effect.runPromise(asServerWork(owned.relocate(ada, plan("m-shared"))));
    await Effect.runPromise(asServerWork(owned.relocate(anyone, plan("m-ada"))));
    // Never onto a machine started for someone else than its starter.
    const changed = await Effect.runPromiseExit(asServerWork(owned.relocate(grace, plan("m-ada"))));
    expect(String(changed)).toContain(MOVE_CHANGES_OWNER);
    // And while it waits, nobody else reaches it: to them it isn't there.
    const refused = await Effect.runPromise(
      as("grace")(owned.relocate(ada, plan("m-ada"))).pipe(Effect.flip),
    );
    expect(refused._tag).toBe("ThreadNotFound");
    expect(await outcome(as("grace")(owned.send(ada, { text: "Grace's" }) as never))).toBe(
      NOT_YOUR_MACHINE,
    );
    await Effect.runPromise(as("ada")(owned.send(ada, { text: "Ada's" })));
    expect(reached).toEqual([
      `relocate:${ada}`,
      `relocate:${ada}`,
      `relocate:${anyone}`,
      `send:${ada}`,
    ]);
  });
});

// Fail-closed ownership (`host/ownership.ts`): a host started on demand says whom it is for, a
// person or an explicit shared scope; one that names neither is the server's own work's alone;
// and the server's own work is a capability, never a call with no caller.
describe("hosts provisioned on demand: those that name no one, and shared ones", () => {
  const noOnes = machine({ id: "m-noone", onDemand: "thread" });
  const runOne = machine({
    id: "m-run1",
    onDemand: "thread",
    shared: { scope: "run:1", people: ["ada"] },
  });
  const runOneAgain = machine({
    id: "m-run1b",
    onDemand: "thread",
    shared: { scope: "run:1", people: [] },
  });
  const runTwo = machine({
    id: "m-run2",
    onDemand: "thread",
    shared: { scope: "run:2", people: ["ada"] },
  });
  const all = [adaBox, sharedBox, noOnes, runOne, runOneAgain, runTwo];
  const owners = ownersOf({ list: () => all });
  const reaches = (hostId: string, caller: Parameters<typeof RoutedFor.of>[0] | "unsaid") =>
    Effect.runPromise(
      caller === "unsaid"
        ? mayReach(owners, id(hostId))
        : mayReach(owners, id(hostId)).pipe(Effect.provideService(RoutedFor, caller)),
    );

  it("reaches a host that names no one only as the server's own work", async () => {
    expect(owners(id("m-noone"))).toBe(NOBODY);
    for (const caller of [
      { person: "ada" },
      { person: undefined },
      { person: undefined, scope: "run:1" },
    ])
      expect(await reaches("m-noone", caller)).toBe(false);
    expect(await reaches("m-noone", "unsaid")).toBe(false);
    expect(await Effect.runPromise(asServerWork(mayReach(owners, id("m-noone"))))).toBe(true);
  });

  it("takes the server's own work from its capability, never from a call with no caller", async () => {
    expect(await reaches("m-ada", "unsaid")).toBe(false);
    expect(await Effect.runPromise(asServerWork(mayReach(owners, id("m-ada"))))).toBe(true);
    // A machine that is anyone's (not on demand) stays anyone's, a call with no caller included.
    expect(await reaches("m-shared", "unsaid")).toBe(true);
    expect(await reaches("m-shared", { person: "grace" })).toBe(true);
    // A person acting narrows the server's own work it runs under.
    expect(
      await Effect.runPromise(
        asServerWork(
          Effect.map(currentCaller, (caller) => caller?.person).pipe(
            Effect.provideService(ActingPerson, "grace"),
          ),
        ),
      ),
    ).toBe("grace");
  });

  it("reaches a shared host only for the people it names and the agents of its scope", async () => {
    expect(await reaches("m-run1", { person: "ada" })).toBe(true);
    expect(await reaches("m-run1", { person: "grace" })).toBe(false);
    expect(await reaches("m-run1", { person: undefined })).toBe(false);
    expect(await reaches("m-run1", { person: undefined, scope: "run:1" })).toBe(true);
    expect(await reaches("m-run1", { person: undefined, scope: "run:2" })).toBe(false);
    // An empty list admits no person at all.
    expect(await reaches("m-run1b", { person: "ada" })).toBe(false);
    expect(await reaches("m-run1b", { person: undefined, scope: "run:1" })).toBe(true);
  });

  it("counts two hosts one owner's only for one person or one shared scope", () => {
    expect(sameOwner(owners, at("m-run1"), at("m-run1b"))).toBe(true);
    expect(sameOwner(owners, at("m-run1"), at("m-run2"))).toBe(false);
    expect(sameOwner(owners, at("m-run1"), at("m-ada"))).toBe(false);
    expect(sameOwner(owners, at("m-run1"), at("m-shared"))).toBe(false);
    expect(sameOwner(owners, at("m-noone"), at("m-shared"))).toBe(false);
    expect(sameOwner(owners, at("m-noone"), at("m-ada"))).toBe(false);
    // One host is one owner's, whatever it names.
    expect(sameOwner(owners, at("m-noone"), at("m-noone"))).toBe(true);
    // Two hosts that name no one are no one's together: never linked.
    const twoNoOnes = ownersOf({
      list: () => [noOnes, machine({ id: "m-noone2", onDemand: "thread" })],
    });
    expect(sameOwner(twoNoOnes, at("m-noone"), at("m-noone2"))).toBe(false);
    // Machines that are anyone's (this one, joined ones) are one owner's, as before.
    expect(sameOwner(owners, {}, at("m-shared"))).toBe(true);
  });

  it("places new work on them only for a call they admit, never for the server's own", async () => {
    const placement = headlessPlacement({ list: () => all as never }, true);
    const place = (hostId: string, caller: Parameters<typeof RoutedFor.of>[0] | "server") =>
      outcome(
        placeRequest(placement, { kind: "newWorktree", branch: "b", hostId: id(hostId) }).pipe(
          Effect.as("placed"),
          caller === "server" ? asServerWork : Effect.provideService(RoutedFor, caller),
        ),
      );
    for (const caller of [{ person: "ada" }, { person: "grace" }, "server"] as const)
      expect(await place("m-noone", caller)).toBe(NOT_YOUR_MACHINE);
    expect(await place("m-run1", { person: "ada" })).toBe("placed");
    expect(await place("m-run1", { person: undefined, scope: "run:1" })).toBe("placed");
    expect(await place("m-run1", { person: "grace" })).toBe(NOT_YOUR_MACHINE);
    expect(await place("m-run1", "server")).toBe(NOT_YOUR_MACHINE);
  });

  it("runs an agent's call on a shared host in its scope, and on one that names no one as no one", async () => {
    const onShared = stored("run-thread", "m-run1");
    const onNoOnes = stored("noone-thread", "m-noone");
    const lookup = (threadId: ThreadId) =>
      Effect.succeed(threadId === onShared.id ? onShared : onNoOnes);
    const callerAt = (thread: Thread) =>
      Effect.runPromise(asServerWork(asThreadOwner(lookup, owners, thread.id)(currentCaller)));
    expect(await callerAt(onShared)).toEqual({ person: undefined, scope: "run:1" });
    expect(await callerAt(onNoOnes)).toEqual({ person: undefined });
  });
});
