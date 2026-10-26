import type { FeatureCardHeld, WorkspaceId } from "@gram/contracts";
import { Hourglass } from "lucide-react";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import { useThreadsStore } from "@/stores/threads";
import { heldStateText, limitShareText } from "@/usage/limit-format";

// A low-priority brief the orchestrator asked for near a usage limit, held instead of spawned:
// when it starts on its own, why it waits, and Release now to start it without waiting. The
// feature card and the Board both draw it.

/** Release now: the worker arrives with the ledger; a refusal says why in a toast. */
function useRelease(workspaceId: WorkspaceId, held: FeatureCardHeld) {
  const api = useApi();
  const [pending, setPending] = useState(false);
  const release = () => {
    setPending(true);
    api
      .releaseHeldBrief(workspaceId, held.id)
      .catch((error: unknown) =>
        useThreadsStore.getState().applyEvent({
          type: "notify",
          kind: "error",
          title: `Couldn't start ${held.title}`,
          body: errorMessage(error),
        }),
      )
      .finally(() => setPending(false));
  };
  return { pending, release };
}

/** Why it is held, for the tooltip and screen readers. */
const heldWhy = (held: FeatureCardHeld): string =>
  held.reason ??
  (held.waitsForSlot === true
    ? "Its usage limit has reset, but every worker slot is taken, so it starts when a worker finishes."
    : held.retryAt !== undefined
      ? "Its usage limit has reset, but the spawn was refused for now, so it is tried again."
      : `${limitShareText(held)}, so this low-priority brief waits for the reset.`);

const RELEASE =
  "relative shrink-0 rounded-sm px-1 text-[11px] text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** One held brief as a line of a feature card: its title, its release time and Release now. */
export function HeldBriefLine({
  workspaceId,
  held,
}: {
  workspaceId: WorkspaceId;
  held: FeatureCardHeld;
}) {
  const now = useNow(true, undefined, 60_000);
  const { pending, release } = useRelease(workspaceId, held);
  const reason = heldWhy(held);
  return (
    <li
      data-testid="held-brief"
      data-held-id={held.id}
      title={reason}
      className="flex min-w-0 items-center gap-2 text-xs"
    >
      <Hourglass aria-hidden className="-mx-0.75 size-3 shrink-0 text-status-needs" />
      <span className="w-36 min-w-0 shrink-0 truncate font-medium">{held.title}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span data-testid="held-until" className="tabular-nums">
          {heldStateText(held, now)}
        </span>
        <span className="sr-only">. {reason}</span>
      </span>
      <button
        type="button"
        data-testid="held-release"
        disabled={pending}
        onClick={release}
        aria-label={`Release ${held.title} now`}
        className={RELEASE}
      >
        Release now
      </button>
    </li>
  );
}

/** One held brief as a chip on the Board's Briefed station. */
export function HeldBriefChip({
  workspaceId,
  held,
  paused = false,
}: {
  workspaceId: WorkspaceId;
  held: FeatureCardHeld;
  /** Its feature is paused: it waits for the feature's Resume, not for Release now. */
  paused?: boolean;
}) {
  const now = useNow(true, undefined, 60_000);
  const { pending, release } = useRelease(workspaceId, held);
  const reason = heldWhy(held);
  return (
    <li
      data-testid="rail-held"
      data-held-id={held.id}
      title={reason}
      className="flex w-full max-w-52 min-w-0 flex-col items-start gap-0.5 rounded-(--radius-md) border border-dashed border-border bg-card px-2 py-1 text-xs"
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <Hourglass aria-hidden className="size-3 shrink-0 text-status-needs" />
        <span className="min-w-0 truncate font-medium">{held.title}</span>
      </span>
      {/* A station is narrow: "until 18:00" on a line of its own, Release now under it. */}
      <span className="pl-4.5 text-[11px] whitespace-nowrap text-muted-foreground">
        <span className="sr-only">Held brief: </span>
        <span data-testid="held-until" className="tabular-nums">
          {heldStateText(held, now, { short: true })}
        </span>
        <span className="sr-only">. {reason}</span>
      </span>
      <button
        type="button"
        data-testid="held-release"
        disabled={pending || paused}
        onClick={release}
        aria-label={`Release ${held.title} now`}
        title={paused ? "Its feature is paused; resume it to start this" : undefined}
        className={cn(RELEASE, "ml-3.5 whitespace-nowrap")}
      >
        Release now
      </button>
    </li>
  );
}
