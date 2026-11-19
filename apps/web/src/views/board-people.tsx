import type { PeopleNames, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, User, X } from "lucide-react";
import { useState, type MouseEvent } from "react";

import { useApi } from "@/api/context";
import { useServes } from "@/api/use-serves";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/lib/selection";
import { cn } from "@/lib/utils";
import {
  type BoardClash,
  type BoardPerson,
  type PersonKey,
  personName,
} from "@/orchestration/board-people";
import { StatusDot } from "@/orchestration/status-dot";

// The Board's top once more than one person's work is on it (docs/design/mocks/board-directions,
// v2): where two people's work changes the same files, then a card per person saying what they
// are on and what waits on them, which also picks whose lines show. Nothing of it shows on a
// Board that is all one person's work.

/** The names of the people the Board's threads work for, where the server can say. */
export function usePeopleNames(keys: readonly PersonKey[]): PeopleNames | undefined {
  const api = useApi();
  const served = useServes("people.names");
  const ids = keys.filter((key) => key !== "").toSorted();
  const names = useQuery({
    queryKey: ["people", "names", ids],
    queryFn: () => api.peopleNames(ids),
    enabled: served && ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return names.data;
}

/** One person's mark: a person glyph and their name, muted, as a row's second line has it. */
export function OwnerMark({ text, testId }: { text: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-0 items-center gap-1 text-muted-foreground"
    >
      <User aria-hidden className="size-icon-row shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** A clash's key: its two workers. */
const keyOf = (clash: BoardClash) => `${clash.a.worker} ${clash.b.worker}`;

/** The first clash on the Board, with the two lines it names a click away; dismissed per pair. */
export function ClashLine({
  clashes,
  names,
  workspaceId,
  onOpen,
  onMessage,
}: {
  clashes: readonly BoardClash[];
  names: PeopleNames | undefined;
  workspaceId: WorkspaceId;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
  onMessage: (workspaceId: WorkspaceId) => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const open = clashes.filter((clash) => !dismissed.has(keyOf(clash)));
  const clash = open[0];
  if (clash === undefined) return null;
  const whose = (person: PersonKey, first: boolean) => {
    const name = personName(person, names, { capital: first });
    return name === "You" ? "Your" : name === "you" ? "your" : `${name}'s`;
  };
  const link = (side: BoardClash["a"]) => (
    <button
      type="button"
      onClick={(event) => onOpen(side.worker, event)}
      className={cn("rounded-sm font-medium text-foreground hover:underline", FOCUS_RING)}
    >
      {side.title}
    </button>
  );
  return (
    <div
      role="status"
      data-testid="board-clash"
      className="mx-4 mt-2 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-(--radius-md) border border-border-strong px-3 py-1.5 text-meta"
    >
      <CircleAlert aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        {whose(clash.a.person, true)} {link(clash.a)} and {whose(clash.b.person, false)}{" "}
        {link(clash.b)} both change{" "}
        <span className="font-mono">{clash.files.slice(0, 2).join(", ")}</span>
        {open.length > 1 && (
          <span className="text-muted-foreground">{` · ${open.length - 1} more`}</span>
        )}
      </span>
      <Button size="xs" variant="outline" onClick={() => onMessage(workspaceId)}>
        Message the orchestrator
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => setDismissed((previous) => new Set(previous).add(keyOf(clash)))}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

/** A card per person; a click shows only their lines, and Everyone shows all again. */
export function PeopleStrip({
  people,
  names,
  picked,
  onPick,
}: {
  people: readonly BoardPerson[];
  names: PeopleNames | undefined;
  picked: PersonKey | undefined;
  onPick: (key: PersonKey | undefined) => void;
}) {
  return (
    <div
      data-testid="board-people"
      role="group"
      aria-label="Whose work"
      className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-2 pb-2"
    >
      {people.map((person) => {
        const name = personName(person.key, names);
        return (
          <button
            key={person.key}
            type="button"
            aria-pressed={picked === person.key}
            data-testid="board-person"
            onClick={() => onPick(picked === person.key ? undefined : person.key)}
            className={cn(
              "flex w-64 shrink-0 flex-col gap-1 rounded-(--radius-md) border border-border bg-card/40 p-2 text-left text-meta hover:bg-sidebar-row-hover/50",
              picked === person.key && "border-primary",
              FOCUS_RING,
            )}
          >
            <span className="flex items-center gap-1.5 text-reading font-medium">
              <User aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
              <span className="ml-auto shrink-0 font-normal text-muted-foreground tabular-nums">
                {person.features} {person.features === 1 ? "feature" : "features"}
              </span>
            </span>
            {person.workers.slice(0, 2).map((worker) => (
              <span key={worker.threadId} className="flex min-w-0 items-center gap-1.5">
                <StatusDot state={worker.tone} />
                <span
                  className={cn(
                    "truncate",
                    worker.tone === "needs" ? "text-status-needs" : "text-muted-foreground",
                  )}
                >
                  {worker.title} · {worker.now}
                </span>
              </span>
            ))}
          </button>
        );
      })}
      {picked !== undefined && (
        <Button size="xs" variant="ghost" className="self-center" onClick={() => onPick(undefined)}>
          Everyone
        </Button>
      )}
    </div>
  );
}
