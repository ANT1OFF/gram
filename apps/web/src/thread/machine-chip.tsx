import { effectiveCheckout, hostOf, isLocalHost, type Thread } from "@gram/contracts";
import { Server } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { useJoinedMachines } from "@/new-thread/machine-picker";
import { tildify } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";

/**
 * Where a thread on a joined machine runs, in the pane header: the machine's name and its folder
 * there (`~` for its home), the whole path on hover. Nothing for a thread on this machine.
 */
export function MachineChip({ thread, className }: { thread: Thread; className?: string }) {
  const checkout = effectiveCheckout(thread);
  if (isLocalHost(checkout)) return null;
  return <PlacedChip hostId={hostOf(checkout)} path={checkout.path} className={className} />;
}

function PlacedChip({
  hostId,
  path,
  className,
}: {
  hostId: ReturnType<typeof hostOf>;
  path: string;
  className?: string | undefined;
}) {
  const machines = useJoinedMachines();
  const machine = machines?.find((m) => m.id === hostId);
  const name = machine?.name ?? "another machine";
  const home = useHome(machine?.onlineSince === undefined ? undefined : hostId);
  // The home is read through the machine's host: offline, the whole path stands.
  const folder = machine?.onlineSince === undefined ? path : tildify(path, home);
  return (
    <Hint
      label={`Runs on ${name} in ${path}`}
      side="bottom"
      render={
        <span
          data-testid="pane-machine"
          aria-label={`Runs on ${name} in ${path}`}
          className={cn(
            "flex max-w-56 min-w-0 shrink-0 items-center gap-1 text-meta text-muted-foreground",
            className,
          )}
        />
      }
    >
      <Server aria-hidden className="size-icon-chip shrink-0" />
      <span className="truncate">{name}</span>
      <span className="min-w-0 truncate font-mono">{folder}</span>
    </Hint>
  );
}
