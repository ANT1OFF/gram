import { FileText } from "lucide-react";

import { showDoc } from "@/docs/doc-pane-store";
import { useDocs } from "@/docs/doc-queries";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";
import { MockThumb } from "@/thread/mock-visuals";
import { useThreadHeadline } from "@/thread/plan-ui";

import { useWorkspaceAsks } from "./ask-stack";
import type { OverviewWorkerRow } from "./overview-model";
import { useWorkerPrChips, WorkerPrChips } from "./overview-pr-chips";
import type { watchedRuns } from "./waiting-on";
import type { WideFootProps, WideParts } from "./worker-row";

// The parts only the right pane's wide worker row draws (`WorkerRow`'s `wide`): its last line, with
// its PR chips, its plan's steps and the docs it wrote, and an ask's pictures. Apart from the row,
// so the sidebar's row on the first paint doesn't load what only the pane, loaded later, shows.

/**
 * The wide row's last line: its PR chips first, as the sidebar's second line leads with them, then
 * its plan's steps while it has a plan, then the docs it wrote, each a titled chip that opens it.
 * Drawn twice: as `ghost`, inside the row's button, to hold its room; and over that room, outside
 * the button, where its chips and docs are buttons of their own.
 */
function WideFoot({ threadId, done, ghost = false, chips }: WideFootProps) {
  const own = useWorkerPrChips(threadId, chips?.cardPrs ?? NO_CARD_PRS);
  const prChips = chips?.chips ?? own;
  const runs = chips?.runs ?? NO_RUNS;
  const { headline } = useThreadHeadline(threadId);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.thread.workspaceId ?? undefined);
  const docs = useDocs(workspaceId);
  const written = (docs.data?.docs ?? []).filter((doc) => doc.authorThreadId === threadId);
  const steps = !done && headline !== undefined && headline.total > 0 ? headline : undefined;
  if (prChips.length === 0 && runs.length === 0 && steps === undefined && written.length === 0) {
    return null;
  }
  return (
    <span
      aria-hidden={ghost || undefined}
      data-testid={ghost ? undefined : "overview-worker-foot"}
      className={
        ghost
          ? "invisible col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-meta"
          : "pointer-events-none absolute right-1.5 bottom-1.5 left-6 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground *:pointer-events-auto"
      }
    >
      <WorkerPrChips
        threadId={threadId}
        cardPrs={chips?.cardPrs ?? NO_CARD_PRS}
        chips={prChips}
        runs={runs}
        dense
        ghost={ghost}
        foldMerged
        {...(chips === undefined ? {} : { card: chips.card })}
        className="flex shrink-0 items-center"
      />
      {steps !== undefined && <PlanSteps done={steps.done} total={steps.total} />}
      {written.slice(0, DOCS_SHOWN).map((doc) =>
        ghost ? (
          <span key={doc.id} className={DOC_CHIP}>
            <FileText aria-hidden className="size-icon-chip shrink-0" />
            <span className="truncate">{doc.title}</span>
          </span>
        ) : (
          <button
            key={doc.id}
            type="button"
            data-testid="overview-worker-doc"
            data-doc-id={doc.id}
            title={`Open ${doc.title}`}
            onClick={() => {
              if (workspaceId !== undefined) showDoc(workspaceId, doc.id);
            }}
            className={cn(
              DOC_CHIP,
              "text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <FileText aria-hidden className="size-icon-chip shrink-0" />
            <span className="truncate">{doc.title}</span>
          </button>
        ),
      )}
    </span>
  );
}

/** The docs a wide row names before the rest are left to the Docs tab. */
const DOCS_SHOWN = 2;

const DOC_CHIP =
  "inline-flex h-5 max-w-56 min-w-0 items-center gap-1 rounded-full border border-edge px-1.5 text-meta";

const NO_CARD_PRS: OverviewWorkerRow["prs"] = [];
const NO_RUNS: ReturnType<typeof watchedRuns> = [];

/** Its plan as a short bar of steps, the done ones filled, then "Step 2 of 4". */
export function PlanSteps({ done, total }: { done: number; total: number }) {
  const at = Math.min(done + 1, total);
  return (
    <span
      data-testid="plan-steps"
      role="img"
      aria-label={`Step ${at} of ${total}`}
      className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground"
    >
      <span aria-hidden className="flex items-center gap-0.5">
        {Array.from({ length: Math.min(total, 8) }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-0.5 w-2.5 rounded-full",
              i < done ? "bg-muted-foreground" : i === done ? "bg-primary" : "bg-border",
            )}
          />
        ))}
      </span>
      <span aria-hidden className="tabular-nums">
        Step {at} of {total}
      </span>
    </span>
  );
}

/** How many of an ask's pictures a wide row shows. */
const PICTURES_SHOWN = 2;

/** The first pictures of an ask between options, 48 px tall, each with its option's name. */
function AskPictures({ askKey }: { askKey: string }) {
  const asks = useWorkspaceAsks();
  const visuals = asks.flatMap((each) => each.asks).find((ask) => ask.key === askKey)?.visuals;
  const shown = (visuals?.options ?? [])
    .filter((option) => option.image !== undefined)
    .slice(0, PICTURES_SHOWN);
  if (visuals === undefined || shown.length === 0) return null;
  return (
    <div data-testid="overview-worker-pictures" className="flex gap-2 pt-1 pb-1.5 pl-6">
      {shown.map((option) => (
        <figure key={option.label} className="flex w-20 min-w-0 flex-col gap-0.5">
          <MockThumb threadId={visuals.threadId} path={option.image!} label={option.label} />
          <figcaption className="truncate text-caption text-muted-foreground" title={option.label}>
            {option.label}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** The wide row's parts, which the pane passes to `WorkerRow`. */
export const WIDE_ROW_PARTS: WideParts = { Foot: WideFoot, Pictures: AskPictures };
