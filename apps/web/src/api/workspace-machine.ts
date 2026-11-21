import { WORKSPACE_MACHINE_NOT_RUNNING } from "@gram/contracts";

import { sleep } from "@/lib/sleep";

import { errorMessage } from "./errors";
import { fetchOnDemandStatus, startOnDemand } from "./on-demand";

/** How often a wait for a workspace's machine asks whether it is up. */
export const WORKSPACE_MACHINE_POLL_MS = 2_000;
/** How long it waits, as the server waits for a worker's own machine. */
export const WORKSPACE_MACHINE_WAIT_MS = 5 * 60_000;

/** Starts `workspace`'s own machine as the person, and waits until it is online. */
export const startWorkspaceMachine = async (workspace: string, wait = sleep) => {
  await startOnDemand([], {}, { workspace });
  const deadline = Date.now() + WORKSPACE_MACHINE_WAIT_MS;
  for (;;) {
    const status = await fetchOnDemandStatus(workspace);
    if (status?.machine?.online === true) return;
    if (status?.progress?.phase === "failed")
      throw new Error(status.progress.message ?? "Its machine didn't start.");
    if (Date.now() >= deadline)
      throw new Error("Its machine didn't come online in time. Try again in a moment.");
    await wait(WORKSPACE_MACHINE_POLL_MS);
  }
};

/** `open`, and once more after starting the workspace's own machine where that was all it lacked. */
export const onItsMachine = async <T>(
  workspace: string | undefined,
  open: () => Promise<T>,
  start: (workspace: string) => Promise<void> = startWorkspaceMachine,
): Promise<T> => {
  try {
    return await open();
  } catch (e) {
    if (workspace === undefined || !errorMessage(e).includes(WORKSPACE_MACHINE_NOT_RUNNING))
      throw e;
  }
  await start(workspace);
  return open();
};
