import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeOnDemandHosts } from "./on-demand.ts";
import {
  awaitWorkerMachine,
  isWorkerMachineName,
  overTotalWords,
  parseOverTotal,
  pinRefusal,
  resolveWorkerPicks,
  startWorkerMachine,
  workerMachineName,
  placementOf,
} from "./worker-machines.ts";

/** A host provider that answers `/hosts/start` with `status` and `body`, and keeps what it got. */
const provider = async (status: number, body: unknown) => {
  const got: unknown[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      got.push({ path: request.url, body: JSON.parse(text) });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    hosts: makeOnDemandHosts({ url: `http://127.0.0.1:${port}`, token: "t" }),
    got,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
};

const ask = {
  owner: "ada",
  name: "worker-0123456789",
  orchestrator: "t-orch",
  title: "Run the browser suite",
  size: "large",
  architecture: "arm64",
  isolation: "container",
  environment: "6f0c7a4e-2d1b-4c3a-9e8f-1a2b3c4d5e6f",
};

describe("a worker's own machine", () => {
  it("names a retry of the same spawn the same, and a new spawn anew", () => {
    const first = workerMachineName("t-orch", "req-1");
    expect(first).toBe(workerMachineName("t-orch", "req-1"));
    expect(first).not.toBe(workerMachineName("t-orch", "req-2"));
    expect(first).not.toBe(workerMachineName("t-other", "req-1"));
    expect(isWorkerMachineName(first)).toBe(true);
    expect(isWorkerMachineName(workerMachineName("t-orch"))).toBe(true);
    expect(isWorkerMachineName("build box")).toBe(false);
  });

  it.effect("asks the provider for it, with the size, processor, kind and environment picked", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() => provider(200, { hostKey: "k" }));
      const started = yield* startWorkerMachine(fake.hosts, ask);
      yield* Effect.promise(fake.close);
      expect(started).toEqual({ kind: "started", name: ask.name });
      expect(fake.got).toEqual([
        {
          path: "/hosts/start",
          body: {
            kind: "worker",
            owner: "ada",
            name: ask.name,
            options: {
              orchestrator: "t-orch",
              title: "Run the browser suite",
              choices: {
                size: "large",
                architecture: "arm64",
                isolation: "container",
                environment: "6f0c7a4e-2d1b-4c3a-9e8f-1a2b3c4d5e6f",
              },
            },
          },
        },
      ]);
    }),
  );

  it.effect("hands back what is in use when it would go over the total", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() =>
        provider(409, {
          code: "over_total",
          message: "Large would take your workers past 16 CPU.",
          asked: { cpu: 4, memoryGb: 8 },
          inUse: { cpu: 16, memoryGb: 32 },
          total: { cpu: 16, memoryGb: 32 },
          machines: [
            { name: "worker-aaaaaaaaaa", size: "large", architecture: "amd64", running: true },
            { name: "not a worker machine" },
          ],
        }),
      );
      const over = yield* startWorkerMachine(fake.hosts, ask);
      yield* Effect.promise(fake.close);
      expect(over).toEqual({
        kind: "over-total",
        message: "Large would take your workers past 16 CPU.",
        asked: { cpu: 4, memoryGb: 8 },
        inUse: { cpu: 16, memoryGb: 32 },
        total: { cpu: 16, memoryGb: 32 },
        machines: [
          { name: "worker-aaaaaaaaaa", size: "large", architecture: "amd64", running: true },
        ],
      });
      if (over.kind !== "over-total") return;
      const words = overTotalWords(over, () => ["Build the installer [thread t-1]"]);
      expect(words).toContain("In use: 16 CPU · 32 GB of 16 CPU · 32 GB.");
      expect(words).toContain(
        "- worker-aaaaaaaaaa: large, amd64, running, Build the installer [thread t-1]",
      );
      expect(words).toContain("shareWith");
    }),
  );

  it.effect("is refused where the person or their organisation turned it off", () =>
    Effect.gen(function* () {
      const fake = yield* Effect.promise(() =>
        provider(403, { message: "Your organisation doesn't allow workers' own machines." }),
      );
      expect(yield* startWorkerMachine(fake.hosts, ask)).toEqual({
        kind: "refused",
        message: "Your organisation doesn't allow workers' own machines.",
      });
      // Nothing that isn't a short id reaches the provider.
      expect((yield* startWorkerMachine(fake.hosts, { ...ask, size: "LARGE; rm" })).kind).toBe(
        "refused",
      );
      yield* Effect.promise(fake.close);
      expect(fake.got).toHaveLength(1);
    }),
  );

  it("reads a garbled over-total answer as over the total, with nothing listed", () => {
    expect(parseOverTotal("nonsense")).toMatchObject({ kind: "over-total", machines: [] });
  });

  it.live("waits for it to join as its owner's worker machine", () =>
    Effect.gen(function* () {
      let calls = 0;
      const id = yield* awaitWorkerMachine(
        () => {
          calls += 1;
          return [
            // Someone else's, and one not yet online, are not it.
            { id: "m-1", name: ask.name, owner: "grace", onDemand: "worker", onlineSince: 1 },
            ...(calls > 2
              ? [{ id: "m-2", name: ask.name, owner: "ada", onDemand: "worker", onlineSince: 2 }]
              : [{ id: "m-2", name: ask.name, owner: "ada", onDemand: "worker" }]),
          ];
        },
        { name: ask.name, owner: "ada" },
        { everyMs: 1 },
      );
      expect(id).toBe("m-2");
      expect(
        yield* awaitWorkerMachine(
          () => [],
          { name: ask.name, owner: "ada" },
          {
            timeoutMs: 5,
            everyMs: 1,
          },
        ),
      ).toBeUndefined();
    }),
  );
});

describe("placementOf", () => {
  it("keeps the machine, what was named and why, for the worker's row", () => {
    expect(
      placementOf("w-ab12", {
        isolation: "vm",
        architecture: "amd64",
        size: "large",
        reason: " Its tests start Docker. ",
      }),
    ).toEqual({
      machine: "w-ab12",
      picks: { isolation: "vm", architecture: "amd64", size: "large" },
      why: "Its tests start Docker.",
    });
    expect(placementOf("w-ab12", { shareWith: "t-1" })).toEqual({
      machine: "w-ab12",
      shared: true,
    });
  });
});

describe("resolveWorkerPicks", () => {
  const offered = [
    {
      id: "size",
      label: "Size",
      default: "small",
      options: [
        { id: "small", label: "Small", short: "S", available: true },
        { id: "large", label: "Large", short: "L", available: false },
      ],
    },
    {
      id: "isolation",
      label: "Kind",
      default: "vm",
      options: [
        { id: "vm", label: "Virtual machine", short: "VM", available: true },
        { id: "container", label: "Shared container", short: "Container", available: true },
      ],
    },
    {
      id: "environment",
      label: "Environment",
      default: "workspace",
      options: [
        { id: "workspace", label: "The workspace's", available: true },
        { id: "4d3e38fb-a85c-4ef3-861e-176ff82c0dbf", label: "No Internet", available: true },
        { id: "1585b998-71d0-4dcb-b922-e420f0e74f5c", label: "Trusted", available: true },
      ],
    },
  ];

  it("takes an option's id, label or short label, case and punctuation aside", () => {
    expect(
      resolveWorkerPicks(offered, {
        size: "S",
        isolation: "shared container",
        environment: "No Internet",
      }),
    ).toEqual({
      picks: {
        size: "small",
        isolation: "container",
        environment: "4d3e38fb-a85c-4ef3-861e-176ff82c0dbf",
      },
    });
    expect(
      resolveWorkerPicks(offered, { environment: "1585b998-71d0-4dcb-b922-e420f0e74f5c" }),
    ).toEqual({ picks: { environment: "1585b998-71d0-4dcb-b922-e420f0e74f5c" } });
  });

  it("leaves a limit the person's own machine has to the provider", () => {
    expect(resolveWorkerPicks(offered, { size: "large" })).toEqual({ picks: { size: "large" } });
  });

  it("refuses a pick not offered with the options that are", () => {
    const answer = resolveWorkerPicks(offered, { environment: "Offline" });
    expect(answer).toHaveProperty("refused");
    const refused = (answer as { refused: string }).refused;
    expect(refused).toContain("Environment: Offline isn't offered here");
    expect(refused).toContain("No Internet (4d3e38fb-a85c-4ef3-861e-176ff82c0dbf)");
  });

  it("passes picks through as written when the provider offers no choice for them", () => {
    expect(resolveWorkerPicks(undefined, { architecture: "arm64" })).toEqual({
      picks: { architecture: "arm64" },
    });
  });
});

describe("pinRefusal", () => {
  // The machine's `opus` runs another model than the one the orchestrator pinned by its own id.
  const rows = [{ id: "opus", resolvedId: "claude-opus-5-6" }];
  const chosen = { agent: "claude", model: "opus" };

  it("refuses a pin on one model's own id that the machine's alias runs as another", () => {
    expect(pinRefusal("Example", rows, "claude:claude-opus-5-5", chosen)).toMatch(
      /runs claude:opus as claude-opus-5-6, not claude-opus-5-5/,
    );
    expect(pinRefusal("Example", rows, "claude-opus-5-5", chosen)).toBeDefined();
  });

  it("reads the row the launch names exactly, and a pin in any case", () => {
    // `opus` runs 5.5 and `opus[1m]` runs 5.6: a 5.5 pin on a launch of `opus[1m]` is refused.
    const windowed = [
      { id: "opus", resolvedId: "claude-opus-5-5" },
      { id: "opus[1m]", resolvedId: "claude-opus-5-6[1m]" },
    ];
    expect(
      pinRefusal("Example", windowed, "claude-opus-5-5[1m]", {
        agent: "claude",
        model: "opus[1m]",
      }),
    ).toBeDefined();
    expect(
      pinRefusal("Example", windowed, "claude-opus-5-6[1m]", {
        agent: "claude",
        model: "opus[1m]",
      }),
    ).toBeUndefined();
    expect(pinRefusal("Example", rows, "Claude-Opus-5-5", chosen)).toBeDefined();
  });

  it("lets a pin through that the machine runs, or a name that pins no id", () => {
    expect(pinRefusal("Example", rows, "claude-opus-5-6", chosen)).toBeUndefined();
    expect(pinRefusal("Example", rows, "opus", chosen)).toBeUndefined();
    expect(pinRefusal("Example", rows, "tier:lead", chosen)).toBeUndefined();
    expect(pinRefusal("Example", rows, undefined, chosen)).toBeUndefined();
  });
});
