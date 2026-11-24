import type { MachineMove } from "@gram/contracts";
import { ArrowRightLeft } from "lucide-react";

import { machineMoveLabel, machineMoveTitle } from "./machine-move-words";

/** The quiet line a thread shows while its machine moves, in place of an error. */
export function MachineMoveLine({ move }: { move: MachineMove }) {
  return (
    <div
      role="status"
      data-testid="machine-move"
      title={machineMoveTitle(move)}
      className="mx-auto my-2 flex w-full max-w-3xl items-center gap-2 px-1 text-meta text-muted-foreground"
    >
      <ArrowRightLeft aria-hidden className="size-icon-row shrink-0" />
      <span className="min-w-0 flex-1 truncate">{machineMoveLabel(move)}</span>
    </div>
  );
}
