import * as Layer from "effect/Layer";
import { OnDemandLive } from "./on-demand.ts";
import { SignedInWorkersLive, WorkerMachinePort } from "./signed-in-workers.ts";

export const WorkerMachineSourcesLive = Layer.mergeAll(
  OnDemandLive,
  SignedInWorkersLive.pipe(Layer.provide(WorkerMachinePort.layer)),
);
