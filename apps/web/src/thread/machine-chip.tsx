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
 * Where a thread on another machine runs, in the pane header: the machine's name, and that it is
 * offline when it is, then its folder there (`~` for its home), with the whole path and the
 * machine's state on hover. Nothing for a thread on this machine.
 *
 * Two chips rather than one: short of room the header drops whole chips, and the folder is the one
 * to go, so the machine and its state stay as long as any chip does.
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
  const label = [where, ...state].join("\n");
  const Glyph = mark.state === undefined ? Server : ServerOff;
  return (
    <>
      <Hint
        label={label}
        side="bottom"
        render={
          <span
            data-testid="pane-machine"
            data-machine-state={mark.state ?? "online"}
            role="img"
            aria-label={mark.state === undefined ? where : `${where}, ${mark.state}`}
            className={cn(
              // Never wider than the chips' room, so it stays on their one line rather than
              // wrap out of sight with the chips that don't fit.
              "flex max-w-full min-w-0 items-center gap-1 text-meta",
              mark.state === undefined ? "text-muted-foreground" : "text-foreground",
              className,
            )}
          />
        }
      >
        <Glyph aria-hidden className="size-icon-chip shrink-0" />
        {/* Short of room its state's word goes whole, wrapped out of sight, before its name is
            cut: the struck glyph still says it, and the hover says why. */}
        <span className="flex h-lh min-w-0 flex-wrap gap-x-1 overflow-hidden">
          <span className="max-w-full min-w-0 truncate">{name}</span>
          {mark.state !== undefined && <span className="shrink-0">{mark.state}</span>}
        </span>
      </Hint>
      <Hint
        label={label}
        side="bottom"
        render={
          <span
            data-testid="pane-machine-folder"
            aria-hidden
            className={cn(
              "max-w-48 min-w-0 shrink-0 truncate font-mono text-meta text-muted-foreground",
              className,
            )}
          />
        }
      >
        {folder}
      </Hint>
    </>
  );
}
