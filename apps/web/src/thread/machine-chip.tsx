import type { HostId, Thread } from "@gram/contracts";
import { effectiveCheckout } from "@gram/contracts";
import { Server, ServerOff } from "lucide-react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { tildify } from "@/new-thread/path";
import { useHome } from "@/new-thread/use-folder";

import { threadHost } from "./machine-mark";
import { useMachineMark } from "./machine-marker";

/**
 * Where a thread on another machine runs, in the pane header: the machine's name, that it is
 * offline when it is, and its folder there (`~` for its home), with the whole path and the
 * machine's state on hover. Nothing for a thread on this machine.
 */
export function MachineChip({ thread, className }: { thread: Thread; className?: string }) {
  const hostId = threadHost(thread);
  if (hostId === undefined) return null;
  return <PlacedChip hostId={hostId} path={effectiveCheckout(thread).path} className={className} />;
}

function PlacedChip({
  hostId,
  path,
  className,
}: {
  hostId: HostId;
  path: string;
  className?: string | undefined;
}) {
  const mark = useMachineMark(hostId);
  const reachable = mark?.name !== undefined && mark.state === undefined;
  const home = useHome(reachable ? hostId : undefined);
  if (mark === undefined) return null;
  const name = mark.name ?? "another machine";
  // The home is read through the machine's host: offline, the whole path stands.
  const folder = reachable ? tildify(path, home) : path;
  const where = `Runs on ${name} in ${path}`;
  // The hover's first line names the folder too; the rest is the machine's state, as every marker.
  const [, ...state] = mark.hint.split("\n");
  const Glyph = mark.state === undefined ? Server : ServerOff;
  return (
    <Hint
      label={[where, ...state].join("\n")}
      side="bottom"
      render={
        <span
          data-testid="pane-machine"
          data-machine-state={mark.state ?? "online"}
          aria-label={mark.state === undefined ? where : `${where}, ${mark.state}`}
          className={cn(
            "flex max-w-56 min-w-0 shrink-0 items-center gap-1 text-meta text-muted-foreground",
            className,
          )}
        />
      }
    >
      <Glyph
        aria-hidden
        className={cn("size-icon-chip shrink-0", mark.state !== undefined && "text-foreground")}
      />
      <span className={cn("truncate", mark.state !== undefined && "text-foreground")}>{name}</span>
      {mark.state !== undefined && <span className="shrink-0 text-foreground">{mark.state}</span>}
      <span className="min-w-0 truncate font-mono">{folder}</span>
    </Hint>
  );
}
