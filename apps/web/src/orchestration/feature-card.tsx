import {
  FEATURE_STATIONS,
  STATION_LABELS,
  type FeatureCard,
  type FeatureCardPr,
  type FeatureCardWorker,
  type FeatureStation,
  type StreamLine,
  type ThreadId,
} from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, CirclePause, CircleX, type LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { prFactsOfCard } from "@/components/pr-facts";
import { PrMarkIcon } from "@/components/pr-marks";
import { PR_STATE_DISPLAY, prMarksOf, prRefText, prTooltipOf } from "@/components/pr-marks-model";
import { formatClockTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { PulseOnce, Swap } from "@/motion";
import { useOpenThread } from "@/shell/thread-switcher";

import { openFeatureSheet } from "./feature-sheet-store";
import { HeldBriefLine } from "./held-brief";
import { peek } from "./peek-store";
import { useFeatureSummary } from "./use-feature-cards";
import { stationDotClass } from "./overview-model";

// A feature's live card and the stream's one-line events (contracts `feature-cards.ts`). A card is
// drawn once per feature and redrawn in place as its versions arrive; nothing in it animates while
// it sits still.

const stationIndex = (station: FeatureStation) => FEATURE_STATIONS.indexOf(station);

/** ⌘/Ctrl- or Shift-click: straight through, past the peek. */
const throughKey = (event: MouseEvent) => event.metaKey || event.ctrlKey || event.shiftKey;

/**
 * A worker's name, peeking at it in a sheet; ⌘/Ctrl-click or a middle click opens its full view
 * straight away, as the sheet's Open does.
 */
export function WorkerLink({
  threadId,
  children,
  className,
}: {
  threadId: ThreadId;
  children: ReactNode;
  className?: string;
}) {
  const open = useOpenThread();
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId }}
      data-testid="worker-link"
      className={cn(
        "min-w-0 truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline",
        className,
      )}
      onClick={(event) => {
        event.preventDefault();
        if (throughKey(event)) open(threadId);
        else {
          const title = event.currentTarget.textContent ?? "";
          peek({ kind: "worker", threadId, title }, event.currentTarget);
        }
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        open(threadId);
      }}
    >
      {children}
    </Link>
  );
}

/**
 * `api#212` in the PR vocabulary: its state's glyph, the ref, then its checks. With the worker whose PR it is, it peeks at the PR in a sheet, and
 * ⌘/Ctrl-click opens it on GitHub straight away; without, it opens it on GitHub.
 */
export function PrChip({ pr, threadId }: { pr: FeatureCardPr; threadId?: ThreadId | undefined }) {
  const api = useApi();
  const facts = prFactsOfCard(pr);
  const marks = prMarksOf(facts);
  const label = prRefText(pr, { compact: true });
  const title = prTooltipOf(facts, marks);
  // Its name is the ref then what its marks say, so a screen reader hears the glyphs too.
  const name = [label, ...title.split("\n").slice(1)].join(", ");
  const body = (
    <>
      {pr.state !== undefined && <PrMarkIcon group="state" mark={marks.state} />}
      {label}
      {marks.checks?.kind !== "none" && <PrMarkIcon group="checks" mark={marks.checks} />}
    </>
  );
  const chip =
    "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1 font-mono text-[11px] leading-5";
  const live = cn(
    chip,
    "text-foreground no-underline outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
  );
  const github = () =>
    openExternalUrl(api, pr.url!).catch((error: unknown) =>
      console.error("feature card: open PR", error),
    );
  const peekPr = (from: Element) =>
    threadId !== undefined &&
    peek({ kind: "pr", threadId, repo: pr.repo, number: pr.number, url: pr.url }, from);
  if (pr.url === undefined) {
    if (threadId === undefined) {
      return (
        <span data-testid="pr-chip" title={title} className={cn(chip, "text-muted-foreground")}>
          {body}
        </span>
      );
    }
    return (
      <button
        type="button"
        data-testid="pr-chip"
        title={title}
        aria-label={name}
        className={live}
        onClick={(event) => peekPr(event.currentTarget)}
      >
        {body}
      </button>
    );
  }
  return (
    <a
      href={pr.url}
      data-testid="pr-chip"
      title={title}
      aria-label={name}
      className={live}
      onClick={(event) => {
        event.preventDefault();
        if (threadId === undefined || throughKey(event)) void github();
        else peekPr(event.currentTarget);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        void github();
      }}
    >
      {body}
    </a>
  );
}

/**
 * The five stations as a short line, only the card's own named: the stream stays a few words per
 * card, and Board names them all.
 * The others carry their name in a tooltip; a count where more than one worker stands.
 */
function StageLine({ card }: { card: FeatureCard }) {
  const at = stationIndex(card.station);
  return (
    <ol
      aria-label={`Stage: ${STATION_LABELS[card.station]}`}
      data-testid="feature-card-stations"
      className="flex items-center gap-1 text-[11px]"
    >
      {FEATURE_STATIONS.map((station, i) => {
        const count = card.workers.filter((worker) => worker.station === station).length;
        const state = i < at ? "past" : i === at ? "current" : "ahead";
        return (
          <li
            key={station}
            data-station={station}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-center gap-1"
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cn("h-px w-3", i <= at ? "bg-foreground/40" : "bg-border")}
              />
            )}
            <span
              title={state === "current" ? undefined : STATION_LABELS[station]}
              aria-label={state === "current" ? undefined : STATION_LABELS[station]}
              className={cn(
                "inline-flex items-center gap-0.5",
                state === "current"
                  ? "font-medium text-foreground"
                  : state === "past"
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60",
              )}
            >
              {state === "current" ? (
                STATION_LABELS[station]
              ) : (
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", i < at ? "bg-foreground/40" : "bg-border")}
                />
              )}
              {count > 1 && <span className="tabular-nums text-muted-foreground">{count}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function WorkerLine({ worker }: { worker: FeatureCardWorker }) {
  const failed = worker.flag === "error";
  return (
    <li
      data-testid="feature-card-worker"
      data-station={worker.station}
      className="flex min-w-0 items-center gap-2 text-xs"
    >
      <span
        aria-hidden
        title={STATION_LABELS[worker.station]}
        className={cn("size-1.5 shrink-0 rounded-full", stationDotClass(worker.station, failed))}
      />
      <span className="flex w-36 min-w-0 shrink-0" title={worker.model}>
        <WorkerLink threadId={worker.threadId}>{worker.title}</WorkerLink>
      </span>
      <Swap
        swapKey={worker.now}
        className={cn(
          "min-w-0 flex-1 truncate",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span data-testid="feature-card-now">{worker.now}</span>
      </Swap>
      <span className="flex shrink-0 items-center gap-1">
        {worker.prs.map((pr) => (
          <PrChip key={`${pr.repo}#${pr.number}`} pr={pr} threadId={worker.threadId} />
        ))}
      </span>
    </li>
  );
}

/** "Queue worker and Rate limit: queue/retry.py": each pair of workers that touch the same files, once. */
const overlapsOf = (card: FeatureCard) => {
  const titles = new Map(card.workers.map((worker) => [worker.threadId, worker]));
  const seen = new Set<string>();
  const out: {
    key: string;
    a: FeatureCardWorker;
    b: FeatureCardWorker;
    files: readonly string[];
  }[] = [];
  for (const worker of card.workers) {
    for (const other of worker.overlapsWith) {
      const key = [worker.threadId, other].toSorted().join(" ");
      const peer = titles.get(other);
      if (seen.has(key) || peer === undefined) continue;
      seen.add(key);
      out.push({ key, a: worker, b: peer, files: worker.overlapFiles });
    }
  }
  return out;
};

/** A worker in another feature that touches the same files, named by id; the card has its title only when it is its own. */
const foreignOverlaps = (card: FeatureCard) => {
  const mine = new Set(card.workers.map((worker) => worker.threadId));
  return card.workers.flatMap((worker) =>
    worker.overlapsWith
      .filter((other) => !mine.has(other))
      .map((other) => ({ worker, other, files: worker.overlapFiles })),
  );
};

const filesText = (files: readonly string[]) =>
  files.length === 0
    ? "the same files"
    : files.length === 1
      ? files[0]!
      : `${files[0]!} and ${files.length - 1} more`;

/**
 * One feature, live: its name and when it last moved, the helper's sentence when there is one for
 * this version, the five-station stage line, a line per worker (name, now line, PR chips) and any
 * advisory overlap between workers. Complete without the helper.
 */
export function FeatureCardView({
  card,
  workerTitle,
}: {
  card: FeatureCard;
  /** Titles of workers outside this card, for overlap with another feature. */
  workerTitle?: (threadId: ThreadId) => string | undefined;
}) {
  const summary = useFeatureSummary(card);
  const overlaps = overlapsOf(card);
  const foreign = foreignOverlaps(card);
  // Merged, or every worker parked: nothing on it moves any more. A held brief still will.
  const finished =
    card.held === undefined &&
    (card.station === "merged" || card.workers.every((worker) => worker.state === "archived"));
  return (
    <article
      aria-label={`Feature ${card.feature}`}
      data-testid="feature-card"
      data-feature={card.feature}
      data-version={card.version}
      data-station={card.station}
      className="my-1 flex w-full max-w-2xl flex-col gap-1.5 rounded-(--radius-md) border border-border bg-card/40 p-3 text-sm"
    >
      <header className="flex min-w-0 items-center gap-2">
        <PulseOnce
          trigger={card.station}
          tone={card.station === "merged" ? "merged" : "primary"}
          burst={card.station === "merged"}
          className="min-w-0"
        >
          <h3 className="truncate font-medium">
            {/* The name opens the feature's sheet. */}
            <button
              type="button"
              data-testid="feature-card-open"
              onClick={() => openFeatureSheet(card.workspaceId, card.feature)}
              className="max-w-full truncate rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {card.feature}
            </button>
          </h3>
        </PulseOnce>
        {card.group !== undefined && (
          <span className="truncate text-xs text-muted-foreground">{card.group}</span>
        )}
        {card.stage !== undefined && (
          <span
            data-testid="feature-card-stage"
            title={card.stage.note}
            className="max-w-40 truncate rounded-sm bg-muted px-1 text-[11px] text-muted-foreground"
          >
            {card.stage.current}
          </span>
        )}
        <span
          data-testid="feature-card-updated"
          className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {finished ? "" : "live · "}
          {formatClockTime(card.updatedAt)}
        </span>
      </header>
      {summary !== undefined && (
        <p data-testid="feature-card-summary" className="text-xs text-muted-foreground">
          {summary}
        </p>
      )}
      <StageLine card={card} />
      <ul className="flex flex-col gap-0.5">
        {card.workers.map((worker) => (
          <WorkerLine key={worker.threadId} worker={worker} />
        ))}
        {card.held?.map((held) => (
          <HeldBriefLine key={held.id} workspaceId={card.workspaceId} held={held} />
        ))}
      </ul>
      {(overlaps.length > 0 || foreign.length > 0) && (
        <ul data-testid="feature-card-overlap" className="flex flex-col gap-0.5 text-xs">
          {overlaps.map(({ key, a, b, files }) => (
            <li key={key} className="flex min-w-0 items-center gap-1 text-status-needs">
              <CircleAlert aria-hidden className="size-3 shrink-0" />
              <WorkerLink threadId={a.threadId} className="text-status-needs">
                {a.title}
              </WorkerLink>
              and
              <WorkerLink threadId={b.threadId} className="text-status-needs">
                {b.title}
              </WorkerLink>
              <span className="truncate font-mono">· {filesText(files)}</span>
            </li>
          ))}
          {foreign.map(({ worker, other, files }) => (
            <li
              key={`${worker.threadId} ${other}`}
              className="flex min-w-0 items-center gap-1 text-status-needs"
            >
              <CircleAlert aria-hidden className="size-3 shrink-0" />
              <WorkerLink threadId={worker.threadId} className="text-status-needs">
                {worker.title}
              </WorkerLink>
              and
              <WorkerLink threadId={other} className="text-status-needs">
                {workerTitle?.(other) ?? "another worker"}
              </WorkerLink>
              <span className="truncate font-mono">· {filesText(files)}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

const LINE_ICON: Record<StreamLine["kind"], { icon: LucideIcon; className: string }> = {
  merged: { icon: PR_STATE_DISPLAY.merged.icon, className: PR_STATE_DISPLAY.merged.tone },
  delivered: { icon: CircleCheck, className: "text-success" },
  failed: { icon: CircleX, className: "text-destructive" },
  ask: { icon: CircleAlert, className: "text-status-needs" },
  paused: { icon: CirclePause, className: "text-status-needs" },
};

/** One event that spoke: "rate-headers · Rate limit merged api#431 14:12". */
export function StreamLineView({ line, at }: { line: StreamLine; at?: number | undefined }) {
  const tone = LINE_ICON[line.kind];
  return (
    <p
      data-testid="stream-line"
      data-kind={line.kind}
      className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs"
    >
      <tone.icon aria-hidden className={cn("size-3.5 shrink-0", tone.className)} />
      {line.feature !== "" && <span className="text-muted-foreground">{line.feature}</span>}
      {line.threadId !== undefined && (
        <WorkerLink threadId={line.threadId}>{line.title ?? "worker"}</WorkerLink>
      )}
      <span className={tone.className}>{line.words}</span>
      {line.pr !== undefined && <PrChip pr={line.pr} threadId={line.threadId} />}
      {at !== undefined && (
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {formatClockTime(at)}
        </span>
      )}
    </p>
  );
}
