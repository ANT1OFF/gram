import { Popover } from "@base-ui/react/popover";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { isComing } from "@/api/on-demand";
import { useMachineNoun } from "@/embed/store";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { WhereStop } from "@/new-thread/who-does-it";

import { isOwn, pickedFor, shortOf, useOnDemandPicks } from "./on-demand-picks";
import { useOnDemandMachine } from "./start-machine-card";

const RunsOnPanel = lazy(async () => ({
  default: (await import("./runs-on-panel")).RunsOnPanel,
}));

const NAMED = 3;

/**
 * New task's Runs on stop, where the deployment starts a person's machine on demand: what it runs
 * as (the first choices it offers, by their short labels), and one popover to change any of them.
 * A machine that runs starts again with a change; one that doesn't takes it at its next start.
 * Where the deployment keeps picks, each choice says whether it is the person's own or the
 * default, and "Keep as my default" saves them on their account.
 */
export function RunsOnChip() {
  const noun = useMachineNoun();
  const { status } = useOnDemandMachine();
  const { picks } = useOnDemandPicks();
  const [open, setOpen] = useState(false);
  const offered = status?.choices;
  if (offered === undefined) return null;
  const { choices } = offered;
  const values = pickedFor(choices, picks);
  const online = status?.machine?.online === true;
  const coming = isComing(status);
  const anyOwn = choices.some((choice) => isOwn(choice, values[choice.id]!));

  const summary = choices
    .slice(0, NAMED)
    .map((choice) => shortOf(choice, values[choice.id]!))
    .join(" · ");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="runs-on"
        title={`Where this runs: your ${noun}, ${choices.map((c) => `${c.label.toLowerCase()} ${shortOf(c, values[c.id]!)}`).join(", ")}`}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border px-2 text-meta text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent"
      >
        {coming ? (
          <Spinner className="size-3" />
        ) : (
          <span
            aria-label={online ? "Running" : "Not running"}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              online ? "bg-success" : "bg-muted-foreground/50",
            )}
          />
        )}
        <span className="truncate">{summary}</span>
        {anyOwn && (
          <span
            title="Not all defaults: some are your own"
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        )}
        <ChevronDown aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="runs-on-popup"
            className="flex w-[26rem] max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col gap-3 rounded-lg border border-edge bg-popover p-3 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Suspense fallback={<Spinner className="size-4 self-center" />}>
              <RunsOnPanel onDone={() => setOpen(false)} />
            </Suspense>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The Runs on stop on a New form's Where it runs row, where the deployment offers choices. */
export function RunsOnStop() {
  const { status } = useOnDemandMachine();
  if (status?.choices === undefined) return null;
  return (
    <WhereStop label="Runs on">
      <RunsOnChip />
    </WhereStop>
  );
}
