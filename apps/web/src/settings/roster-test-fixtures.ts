import type { WorkerModel } from "@gram/contracts";

/** A saved roster with a gateway model that names no profile: Opus, Sol and Haiku. */
export const SOL_ROSTER: ReadonlyArray<WorkerModel> = [
  {
    speed: "standard",
    agent: "claude",
    model: "opus",
    variant: "high",
    useFor: "implementation, anything cross-cutting",
    default: true,
  },
  {
    agent: "codex",
    speed: "standard",
    model: "gpt-6.1-sol",
    variant: "high",
    useFor: "reviews, bug hunts, audits, tightly scoped changes",
  },
  {
    agent: "claude",
    speed: "standard",
    model: "haiku",
    variant: "medium",
    useFor: "simple tasks, fast and cheap; well-specified work",
  },
];
