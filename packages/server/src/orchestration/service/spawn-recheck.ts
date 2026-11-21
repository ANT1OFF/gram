import { refusal } from "../rules.ts";
import type { SpawnWorkerInput } from "./shape.ts";

/** What the lock found: the live workers and the cap, and the repos outside the workspace. */
export interface SpawnRecount {
  readonly liveWorkers: number;
  readonly maxConcurrentWorkers: number;
  /** Whether one more fits under the cap. */
  readonly fits: boolean;
  /** The named repos outside the workspace, as labels, joined; empty for none. */
  readonly outside: string;
  readonly workspaceName: string;
}

/** Why the spawn starts no worker now, or `undefined` when it may. */
export const spawnRecheckRefusal = (
  input: Pick<SpawnWorkerInput, "unattended" | "uncarded" | "carded">,
  found: SpawnRecount,
): string | undefined => {
  const live = `${found.liveWorkers} workers are live now and the charter allows ${found.maxConcurrentWorkers}`;
  if (input.carded !== undefined)
    return found.fits || found.liveWorkers <= input.carded
      ? undefined
      : refusal(
          "not_admitted",
          `${live}, more than when the user said yes, so no worker started. Call spawn_worker again to ask the user for one more.`,
        );
  if (input.unattended !== true && input.uncarded !== true) return undefined;
  const unattended = input.unattended === true;
  if (found.outside !== "")
    return unattended
      ? refusal(
          "unattended",
          `It needs your approval to add ${found.outside} to the "${found.workspaceName}" workspace, so no worker started.`,
        )
      : refusal(
          "outside_workspace",
          `${found.outside} joined no workspace meanwhile, so no worker started. Call spawn_worker again to ask the user.`,
        );
  if (found.fits) return undefined;
  return unattended
    ? refusal(
        "unattended_cap",
        `It needs your approval: ${found.liveWorkers} workers are live and the charter allows ${found.maxConcurrentWorkers}, so no worker started.`,
      )
    : refusal(
        "not_admitted",
        `${live}, so no worker started. Call spawn_worker again to ask the user for one more.`,
      );
};
