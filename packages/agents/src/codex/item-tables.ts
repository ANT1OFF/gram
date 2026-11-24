import type { FileChange, PlanItem } from "@gram/contracts";

import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.ts";

/** The title each collaboration tool's card shows. */
export const COLLAB_TITLES = {
  spawnAgent: "Spawn agent",
  sendInput: "Send agent input",
  resumeAgent: "Resume agent",
  wait: "Wait for agents",
  closeAgent: "Close agent",
  sendMessage: "Message agent",
  followupTask: "Assign agent task",
  interruptAgent: "Interrupt agent",
  listAgents: "List agents",
} as const;

/** A plan step's status as Gram's plan part has it. */
export const PLAN_STATUS: Record<string, PlanItem["status"]> = {
  pending: "pending",
  inProgress: "inProgress",
  completed: "completed",
};

/** A file change's kind as Gram's file card has it. */
export const FILE_KIND: Record<FileUpdateChange["kind"]["type"], FileChange["kind"]> = {
  add: "add",
  delete: "delete",
  update: "modify",
};
