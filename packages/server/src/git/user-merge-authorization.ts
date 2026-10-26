import { samePr, type Thread, type ThreadId } from "@gram/contracts";
import type { ThreadUpdateContext } from "../persistence/thread-store.ts";
import { fullAutonomyAllows, isDelegated } from "../orchestration/rules.ts";

/** Exact scope of a recorded per-call approval; no other flag or binding implies provenance. */
export const userMergeAuthorizationMatches = (
  caller: ThreadId,
  thread: Thread,
  pr: { readonly repo: string; readonly number: number },
  method: "squash" | "merge" | "rebase",
) => {
  const bound = thread.boundPr;
  const intent = bound?.mergeWhenReady;
  const approval = intent?.userAuthorization;
  return (
    approval !== undefined &&
    intent?.allowedBy === "user" &&
    caller !== thread.id &&
    approval.callerId === caller &&
    approval.threadId === thread.id &&
    approval.workspaceId === thread.workspaceId &&
    bound !== undefined &&
    samePr(bound, pr) &&
    samePr(approval, pr) &&
    approval.method === method &&
    intent.method === method &&
    intent.heldBy !== "thread"
  );
};

/** Only the active workspace orchestrator can create reusable approval provenance. */
export const userMergeApproverIsOrchestrator = (
  caller: ThreadId,
  thread: Thread,
  context: ThreadUpdateContext | undefined,
) =>
  context !== undefined &&
  context.caller?.id === caller &&
  !context.caller.parked &&
  context.caller.babysit === undefined &&
  thread.workspaceId === context.caller.workspaceId &&
  isDelegated({
    caller: context.caller,
    target: thread,
    workspace: context.workspace?.workspace,
  });

/** Evaluated inside the mutation transaction, alongside the binding and approval identity. */
export const userMergeDelegationIsLive = (
  caller: ThreadId,
  thread: Thread,
  context: ThreadUpdateContext | undefined,
) =>
  context !== undefined &&
  context.caller?.id === caller &&
  !thread.parked &&
  thread.babysit === undefined &&
  !context.caller.parked &&
  context.caller.babysit === undefined &&
  thread.workspaceId === context.caller.workspaceId &&
  fullAutonomyAllows({
    caller: context.caller,
    target: thread,
    workspace: context.workspace?.workspace,
    charter: context.workspace?.charter,
    paused: context.workspace?.paused !== undefined,
  });
