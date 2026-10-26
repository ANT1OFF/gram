import type { ModelRef, TaskModelSelection } from "@gram/contracts";

export const sameTaskModel = (left: ModelRef, right: ModelRef): boolean =>
  left.agent === right.agent &&
  left.model === right.model &&
  left.profileId === right.profileId &&
  left.variant === right.variant &&
  (left.speed ?? "standard") === (right.speed ?? "standard");

export const sameTaskSelection = (left: TaskModelSelection, right: TaskModelSelection): boolean =>
  sameTaskModel(left.orchestrator, right.orchestrator) &&
  left.orchestratorThreadId === right.orchestratorThreadId &&
  (left.worker === undefined || right.worker === undefined
    ? left.worker === right.worker
    : sameTaskModel(left.worker, right.worker));
