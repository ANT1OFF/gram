import {
  FEATURE_STATIONS,
  STATION_LABELS,
  type FeatureStation,
  type ThreadId,
} from "@gram/contracts";
import { useState, type MouseEvent } from "react";

import { agentLabel } from "@/agents/agent-label";
import { cn } from "@/lib/utils";
import { WorkerPrChips } from "@/orchestration/overview-pr-chips";
import { HeldBriefChip } from "@/orchestration/held-brief";
import { calmTone, type RailRow, type RailWorker } from "@/orchestration/rail-model";
import { RAIL_TONES } from "@/orchestration/rail-tones";
import { StatusDot } from "@/orchestration/status-dot";
import { useThreadsStore } from "@/stores/threads";

// The Board on a phone: a card per task rather than the grid's columns or the lanes, which a
// 390 px window clips. Each card says its dot, title and state, its stage bar, then its station,
// agent and PR; Now, Waiting and Done stand in for the desktop's lines and Done band. A tap opens
// the worker's thread, or its ask in the Inbox, as the desktop's row does.

export type PhoneBoardSegment = "now" | "waiting" | "done";

const SEGMENTS: readonly {
  readonly id: PhoneBoardSegment;
  readonly label: string;
}[] = [
  { id: "now", label: "Now" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

/** One worker as a phone card, with the line it is on. */
export interface PhoneCard {
  readonly worker: RailWorker;
  readonly station: FeatureStation;
  readonly row: RailRow;
}

/** Which segment a worker's card falls in: finished work in Done, calm work in Waiting. */
export const phoneSegmentOf = (card: PhoneCard): PhoneBoardSegment =>
  card.row.settled || card.row.finished || card.worker.tone === "merged"
    ? "done"
    : calmTone(card.worker.tone)
      ? "waiting"
      : "now";

/** Every worker on the Board's lines and in Done, as cards, in the stations' order per line. */
export const phoneCards = (rows: readonly RailRow[]): readonly PhoneCard[] =>
  rows.flatMap((row) =>
    FEATURE_STATIONS.flatMap((station) =>
      row.cells[station].map((worker) => ({ worker, station, row })),
    ),
  );

/** The stage bar: a segment per station, the current one in the accent, the rest grey. */
function StageBar({ station }: { station: FeatureStation }) {
  const at = FEATURE_STATIONS.indexOf(station);
  const name = `${STATION_LABELS[station]}, step ${at + 1} of ${FEATURE_STATIONS.length}`;
  return (
    <span role="img" aria-label={name} data-testid="phone-board-stage" className="flex gap-0.5">
      {FEATURE_STATIONS.map((each, index) => (
        <i
          key={each}
          data-step={index < at ? "done" : index === at ? "current" : "upcoming"}
          className={cn(
            "h-1 flex-1 rounded-full",
            index < at ? "bg-muted-foreground" : index === at ? "bg-primary" : "bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}

function TaskCard({
  card,
  asking,
  onOpen,
}: {
  card: PhoneCard;
  asking: boolean;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  const { worker, station } = card;
  const tone = RAIL_TONES[worker.tone];
  const agent = useThreadsStore((s) => s.byId[worker.threadId]?.thread.model?.agent);
  return (
    <li
      data-testid="phone-board-card"
      data-thread-id={worker.threadId}
      data-tone={worker.tone}
      data-asking={asking || undefined}
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-(--radius-xl) border border-edge bg-card px-3.5 py-3 focus-within:ring-2 focus-within:ring-ring",
        worker.tone === "needs" && "border-status-needs-mark/60",
      )}
    >
      {/* The title's button stretches over the whole card; the PR chips sit above it. */}
      <button
        type="button"
        data-testid="phone-board-open"
        onClick={(event) => onOpen(worker.threadId, event)}
        aria-label={`${worker.title}, ${tone.label}, ${worker.now}`}
        className="flex min-h-6 min-w-0 items-center gap-2.5 text-left outline-none after:absolute after:inset-0 after:content-['']"
      >
        <StatusDot state={worker.tone} />
        <span className="min-w-0 flex-1 truncate text-reading font-medium">{worker.title}</span>
        <span
          className={cn(
            "max-w-[40%] shrink-0 truncate text-meta",
            worker.tone === "needs"
              ? "text-status-needs"
              : worker.tone === "error"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          {tone.label}
        </span>
      </button>
      <StageBar station={station} />
      <span className="flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
        <span className="min-w-0 truncate">
          {STATION_LABELS[station]}
          {agent !== undefined && ` · ${agentLabel(agent)}`}
        </span>
        <WorkerPrChips
          threadId={worker.threadId}
          cardPrs={worker.prs}
          className="relative ml-auto min-w-0 shrink-0"
        />
      </span>
    </li>
  );
}

/**
 * The phone's Board: Now, Waiting and Done as a segmented row with their counts, and the chosen
 * segment's cards. Held briefs wait in Waiting.
 */
export function PhoneBoard({
  rows,
  done,
  asking,
  onOpen,
}: {
  /** The Board's lines (`boardRows`). */
  rows: readonly RailRow[];
  /** The lines that have left it for Done (`doneRows`). */
  done: readonly RailRow[];
  asking: ReadonlySet<ThreadId>;
  onOpen: (threadId: ThreadId, event: MouseEvent) => void;
}) {
  const cards = phoneCards([...rows, ...done]);
  const held = rows.flatMap((row) => row.held.map((each) => ({ row, held: each })));
  const by = (segment: PhoneBoardSegment) =>
    cards.filter((card) => phoneSegmentOf(card) === segment);
  const counts: Record<PhoneBoardSegment, number> = {
    now: by("now").length,
    waiting: by("waiting").length + held.length,
    done: by("done").length,
  };
  const [picked, setPicked] = useState<PhoneBoardSegment | undefined>(undefined);
  // Until one is picked, the first with anything in it.
  const segment = picked ?? SEGMENTS.find(({ id }) => counts[id] > 0)?.id ?? "now";
  const shown = by(segment);
  return (
    <div data-testid="phone-board" className="flex flex-col gap-2 px-4 pt-2">
      <div
        role="radiogroup"
        aria-label="Show"
        data-testid="phone-board-segments"
        className="flex gap-1.5"
      >
        {SEGMENTS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={segment === id}
            data-segment={id}
            onClick={() => setPicked(id)}
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-edge px-3.5 text-reading text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
              segment === id && "bg-accent font-medium text-foreground",
            )}
          >
            {label}
            <span className="tabular-nums">{counts[id]}</span>
          </button>
        ))}
      </div>
      <ul
        aria-label="Tasks"
        className="flex flex-col gap-2.5 pb-2 [&>[data-testid=rail-held]]:max-w-none"
      >
        {shown.map((card) => (
          <TaskCard
            key={card.worker.threadId}
            card={card}
            asking={asking.has(card.worker.threadId)}
            onOpen={onOpen}
          />
        ))}
        {segment === "waiting" &&
          held.map(({ row, held: each }) => (
            <HeldBriefChip
              key={each.id}
              workspaceId={row.card.workspaceId}
              held={each}
              paused={row.card.paused === true}
            />
          ))}
      </ul>
      {shown.length === 0 && (segment !== "waiting" || held.length === 0) && (
        <p
          data-testid="phone-board-none"
          className="py-6 text-center text-meta text-muted-foreground"
        >
          Nothing here.
        </p>
      )}
    </div>
  );
}
