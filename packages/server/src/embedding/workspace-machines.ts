// A workspace's own machine, through the embedder's host provider.
//
// A headless Gram places a workspace's orchestrator, and so its workers, on the person's own
// machine (`on-demand.ts`). A workspace with an environment of its own (`Workspace.environment`)
// runs instead on a machine of its own, started in that environment: what one workspace installs
// and may reach is then not every other workspace's.
//
// The person starts it, as they start their own: `/machines/on-demand/start` with `{workspace}`,
// a request the fronting proxy signs as theirs, which goes to the provider as the proof that they
// asked (`POST /hosts/start`, `kind: "workspace"`). The provider decides whether they may have it,
// and in that environment. It registers the machine here (`/machines/provision`) under the name
// asked for, with the person as its owner and `onDemand: "thread"`: it takes only the threads
// placed on it by name, and is never anyone's default. Opening the workspace's orchestrator places
// it there; with the machine not running, it is refused with `WORKSPACE_MACHINE_NOT_RUNNING`, and
// the app starts it and opens it again. The orchestrator's workers go on it as on any
// orchestrator's own machine (`orchestration/service/spawning.ts`).

import {
  type HostId,
  InvalidState,
  WORKSPACE_MACHINE_NOT_RUNNING,
  type WorkspaceId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { OwnedMachine } from "./on-demand.ts";

/** A workspace's id as a start names it. */
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The name a workspace's machine registers under: one per person and workspace. */
export const workspaceMachineName = (owner: string, workspace: string): string =>
  `workspace-${createHash("sha256").update(`${owner}\n${workspace}`).digest("hex").slice(0, 10)}`;

/** Where a start's progress is kept: the person's own under their id, a workspace's beside it. */
export const progressKey = (owner: string, workspace?: string): string =>
  workspace === undefined ? owner : `${owner}\n${workspace}`;

/** `person`'s machine for `workspace`, the newest that is online first. */
export const workspaceMachine = (
  machines: ReadonlyArray<OwnedMachine>,
  person: string,
  workspace: string,
): OwnedMachine | undefined => {
  const name = workspaceMachineName(person, workspace);
  return machines
    .filter(
      (machine) =>
        machine.owner === person && machine.onDemand === "thread" && machine.name === name,
    )
    .toSorted((a, b) => (b.onlineSince ?? 0) - (a.onlineSince ?? 0))[0];
};

/** What a workspace's machine is started for. */
export interface WorkspaceToStart {
  readonly id: string;
  readonly name: string;
  readonly environment?: string | undefined;
}

/** The workspace `id` as its machine is started for, if there is one. */
export const workspaceToStart = (
  store: Pick<ThreadStoreShape, "getWorkspace"> | undefined,
  id: string,
): Effect.Effect<WorkspaceToStart | undefined> =>
  store === undefined
    ? Effect.succeed(undefined)
    : store.getWorkspace(id as WorkspaceId).pipe(
        Effect.map(({ workspace }) => ({
          id: workspace.id,
          name: workspace.name,
          environment: workspace.environment,
        })),
        Effect.orElseSucceed(() => undefined),
      );

/** The provider's `/hosts/start` body for `owner`'s machine for `workspace`. */
export const workspaceStartBody = (
  owner: string,
  workspace: WorkspaceToStart & { readonly environment: string },
  repositories: ReadonlyArray<string>,
  proof: unknown,
) => ({
  kind: "workspace",
  owner,
  name: workspaceMachineName(owner, workspace.id),
  options: {
    workspace: workspace.id,
    title: workspace.name.slice(0, 120),
    environment: workspace.environment,
    repositories,
  },
  proof,
});

/**
 * The machine a workspace's orchestrator goes on: undefined where it goes where any thread of the
 * person's does (no provider starts machines, nobody signed in opens it, or the workspace has no
 * environment of its own). Its machine is refused when it isn't online: the person starts it.
 */
export const workspaceHost = (
  provider: boolean,
  machines: () => ReadonlyArray<OwnedMachine>,
  owner: string | undefined,
  workspace: WorkspaceToStart,
): Effect.Effect<HostId | undefined, InvalidState> => {
  if (!provider || owner === undefined || workspace.environment === undefined)
    return Effect.succeed(undefined);
  const machine = workspaceMachine(machines(), owner, workspace.id);
  return machine?.onlineSince === undefined
    ? Effect.fail(
        new InvalidState({
          message: `${WORKSPACE_MACHINE_NOT_RUNNING}. Start it to open ${workspace.name}'s orchestrator.`,
        }),
      )
    : Effect.succeed(machine.id as HostId);
};
