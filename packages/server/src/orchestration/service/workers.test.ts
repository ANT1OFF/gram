import { HostId, type WorkerLedgerEntry } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { compactWorkerRow } from "../ledger.ts";
import { withMachines } from "./workers.ts";

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
