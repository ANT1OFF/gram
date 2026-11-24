import { HostId, type WorkerLedgerEntry } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { compactWorkerRow } from "../ledger.ts";
import { compactSharedRow } from "../worker-packing.ts";
import { machineSharers, machinesForOrchestrator, withMachines } from "./workers.ts";

const ATLAS = HostId.make("m-0123456789abcdef01234567");
const STUDIO = HostId.make("m-89abcdef0123456701234567");
const GONE = HostId.make("m-456789abcdef012301234567");

const machines = [
  { id: ATLAS, name: "atlas", onlineSince: 1 },
  { id: STUDIO, name: "studio" },
];

describe("list_workers' machine on a worker's row", () => {
  it("names the machine a worker runs on and whether it is dialled in", () => {
    const rows = withMachines(
      [{ title: "here" }, { title: "up", hostId: ATLAS }, { title: "down", hostId: STUDIO }],
      machines,
    );
    expect(rows).toEqual([
      { title: "here" },
      { title: "up", hostId: ATLAS, machine: { name: "atlas", online: true } },
      { title: "down", hostId: STUDIO, machine: { name: "studio", online: false } },
    ]);
  });

  it("leaves a worker on a machine that is no longer joined with its id alone", () => {
    expect(withMachines([{ title: "left", hostId: GONE }], machines)).toEqual([
      { title: "left", hostId: GONE },
    ]);
  });

  it("is kept on the compact row an orchestrator reads by default", () => {
    const [worker] = withMachines(
      [
        {
          threadId: "t-1",
          title: "down",
          state: "working",
          status: "idle",
          project: "api",
          hostId: STUDIO,
          pendingRequests: [],
          overlapsWith: [],
          changedFiles: 0,
          userIntervened: false,
          messagesFromOrchestrator: 0,
        } as unknown as WorkerLedgerEntry,
      ],
      machines,
    );
    expect(compactWorkerRow(worker!).machine).toEqual({ name: "studio", online: false });
  });
});

const row = (threadId: string, hostId: HostId | undefined, state = "working") =>
  ({
    threadId,
    title: threadId,
    state,
    status: state === "merged" ? "ended" : "idle",
    project: "api",
    ...(hostId === undefined ? {} : { hostId }),
    pendingRequests: [],
    overlapsWith: [],
    changedFiles: 0,
    userIntervened: false,
    messagesFromOrchestrator: 0,
  }) as unknown as WorkerLedgerEntry;

describe("who shares a machine, as list_workers says it", () => {
  const rows = [
    row("t-a", ATLAS),
    row("t-b", ATLAS),
    row("t-done", ATLAS, "merged"),
    row("t-alone", STUDIO),
    row("t-here", undefined),
  ];
  const threads = [
    {
      id: "t-a",
      spawnedBy: {
        threadId: "t-o",
        feature: "f",
        placement: { machine: "atlas", packing: "shared" },
      },
    },
    {
      id: "t-b",
      spawnedBy: {
        threadId: "t-o",
        feature: "f",
        placement: { machine: "atlas", packing: "named" },
      },
    },
    {
      id: "t-alone",
      spawnedBy: {
        threadId: "t-o",
        feature: "f",
        placement: { machine: "studio", packing: "exclusive" },
      },
    },
    { id: "t-here", spawnedBy: { threadId: "t-o", feature: "f" } },
  ] as never;

  it("names the unfinished workers on a worker's machine, and how each was packed there", () => {
    const sharers = machineSharers(rows, threads);
    // A filter left `t-b` out of what is listed: it still shares the machine with `t-a`.
    const listed = withMachines([rows[0]!, rows[3]!, rows[4]!], machines, sharers);
    expect(listed[0]).toMatchObject({ packing: "shared", sharesWith: ["t-b"] });
    expect(listed[1]).toMatchObject({ packing: "exclusive" });
    expect(listed[1]).not.toHaveProperty("sharesWith");
    expect(listed[2]).not.toHaveProperty("packing");
    expect(sharers.on(ATLAS)).toEqual(["t-a", "t-b"]);
  });

  it("is kept on the compact row an orchestrator reads by default", () => {
    const [worker] = withMachines([rows[0]!], machines, machineSharers(rows, threads));
    expect(compactSharedRow(worker as WorkerLedgerEntry)).toMatchObject({
      machine: { name: "atlas", online: true },
      packing: "shared",
      sharesWith: ["t-b"],
    });
    expect(compactSharedRow(rows[4]!)).not.toHaveProperty("sharesWith");
  });
});

describe("list_workers' machines", () => {
  const OWN = HostId.make("m-aaaaaaaaaaaaaaaaaaaaaaaa");
  const IDLE = HostId.make("m-bbbbbbbbbbbbbbbbbbbbbbbb");
  const BUSY = HostId.make("m-cccccccccccccccccccccccc");
  const OTHERS = HostId.make("m-dddddddddddddddddddddddd");
  const RUN = HostId.make("m-eeeeeeeeeeeeeeeeeeeeeeee");
  const LIVE = HostId.make("m-ffffffffffffffffffffffff");
  const joined = [
    { id: OWN, name: "own", owner: "ann", onDemand: "personal" as const },
    { id: IDLE, name: "idle", owner: "ann", onDemand: "worker" as const },
    { id: BUSY, name: "busy", owner: "ann", onDemand: "worker" as const },
    { id: LIVE, name: "live", owner: "ann", onDemand: "worker" as const, onlineSince: 5 },
    { id: OTHERS, name: "others", owner: "bob", onDemand: "personal" as const, onlineSince: 1 },
    { id: RUN, name: "run", owner: "ann", onDemand: "thread" as const, onlineSince: 1 },
  ];

  it("names the orchestrator's own, its live worker machines and the ones its workers are on", () => {
    const listed = machinesForOrchestrator(joined, {
      own: OWN,
      ownOwner: "ann",
      headless: true,
      inUse: new Set([BUSY]),
    });
    expect(listed.map((m) => m.name)).toEqual(["own", "busy", "live"]);
  });

  it("keeps machines started for nothing in particular on a Gram that runs work itself", () => {
    const plain = [{ id: IDLE, name: "studio" }];
    const context = { own: undefined, ownOwner: undefined, inUse: new Set<string>() };
    expect(machinesForOrchestrator(plain, { ...context, headless: false })).toEqual(plain);
    expect(machinesForOrchestrator(plain, { ...context, headless: true })).toEqual([]);
  });
});
