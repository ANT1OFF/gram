import type { MachineMove } from "@gram/contracts";

import { formatStamp } from "@/lib/time";

/**
 * "cachyos is moving to a new machine · this thread resumes on its own": its machine is being
 * replaced (`Thread.machineMove`), and its session waits for it to carry on. Not a failure.
 */
export const machineMoveLabel = (move: Pick<MachineMove, "machine">): string =>
  `${move.machine} is moving to a new machine · this thread resumes on its own`;

/** What the line says on hover: how long Gram waits, and what happens if the machine isn't back. */
export const machineMoveTitle = (
  move: Pick<MachineMove, "machine" | "until">,
  now = Date.now(),
  intl: { readonly timeZone?: string } = {},
): string =>
  `${move.machine} is being replaced, which cut the agent's turn short. Gram carries the turn on when the machine is back, and waits until ${formatStamp(move.until, now, intl)}; if it isn't back by then, the turn stops and says why.`;
