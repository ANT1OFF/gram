/** The calls a worker machine is asked for and looked after with, under `worker_machines_endpoint`. */
export const WORKER_MACHINE_CALLS = [
  "choices",
  "start",
  "status",
  "release",
  "stop",
  "resize",
] as const;
export type WorkerMachineCall = (typeof WORKER_MACHINE_CALLS)[number];

/** A worker machine's name, as the server picks it (`worker-` and hex). */
export const WORKER_MACHINE_NAME = /^worker-[a-z0-9]{8,16}$/;

/** The server a worker machine may be asked of: signed in, not paused, and it starts them. */
export interface WorkerMachineServer {
  readonly origin: string;
  /** What the server calls itself, as the app shows it. */
  readonly server: string;
  /** The server's mark as Gram keeps it (`hostedLogoOf`), where it gave one the app could read. */
  readonly logo?: string;
  /**
   * An opaque mark of the sign-in machines are asked for under there (who the person is on that
   * server, as the app hashes it). What is made under one sign-in is acted on only under it.
   */
  readonly account?: string;
  /**
   * The marks this same sign-in had before `account` (one of its own, until a renewal named its
   * organisation): what was made under them is this sign-in's, and is moved to `account`.
   */
  readonly formerAccounts?: ReadonlyArray<string>;
}

/**
 * One signed-in server's sign-in as worker machines carry it: its mark, and the marks it had
 * before, whose machines and stops are moved to it. Told for every sign-in, paused or not.
 */
export interface WorkerMachineMarks {
  readonly origin: string;
  readonly account: string;
  readonly formerAccounts: ReadonlyArray<string>;
}
