import type { Thread, WorkerError } from "@gram/contracts";

/** A thread's `lastError` as the ledger and the `workerError` wake carry it. */
export const workerErrorOf = (thread: Thread): WorkerError | undefined => {
  const error = thread.lastError;
  if (error === undefined) return undefined;
  return {
    kind: error.kind,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    text: error.text,
    ...(error.machineLost === undefined ? {} : { lostMachine: true as const }),
  };
};
