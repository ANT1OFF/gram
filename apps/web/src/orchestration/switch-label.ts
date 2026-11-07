import type { Thread } from "@gram/contracts";

/** What opens the switch: "View orchestrator switch…" while one is under way. */
export const switchOpenLabel = (thread: Pick<Thread, "sessionSwitch">): string =>
  thread.sessionSwitch === undefined ? "Switch orchestrator…" : "View orchestrator switch…";
