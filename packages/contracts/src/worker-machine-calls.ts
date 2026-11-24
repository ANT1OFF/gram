/** The calls a worker machine is asked for and looked after with, under `worker_machines_endpoint`. */
export const WORKER_MACHINE_CALLS = [
  "choices",
  "start",
  "status",
  "release",
  "stop",
  "resize",
  "move",
  "workers",
  "machines",
] as const;
export type WorkerMachineCall = (typeof WORKER_MACHINE_CALLS)[number];

/** A worker machine's name, as the server picks it (`worker-` and hex). */
export const WORKER_MACHINE_NAME = /^worker-[a-z0-9]{8,16}$/;
