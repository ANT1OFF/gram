// Where `sandbox` gets a worker a machine of its own: the embedder's host provider, and, in the
// desktop app, worker machines from a hosted server it is signed in to.

import * as Layer from "effect/Layer";
import { OnDemandLive } from "./on-demand.ts";
import { SignedInWorkersLive, WorkerMachinePort } from "./signed-in-workers.ts";

export const WorkerMachineSourcesLive = Layer.mergeAll(
  OnDemandLive,
  // In the desktop app, worker machines from a hosted server it is signed in to.
  SignedInWorkersLive.pipe(Layer.provide(WorkerMachinePort.layer)),
);
