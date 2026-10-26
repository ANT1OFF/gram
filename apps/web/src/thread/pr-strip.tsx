import { Popover } from "@base-ui/react/popover";
import {
  DEFAULT_BABYSIT_ROUNDS,
  hiddenEntryOf,
  type ChecksRollup,
  type PrReviewState,
  type ThreadId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  Circle,
  CircleCheck,
  CircleX,
  ArrowUpToLine,
  ExternalLink,
  EyeOff,
  GitPullRequest,
  Unlink,
  X,
  type LucideIcon,
} from "lucide-react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { openPrPanel, openPrReview } from "@/components/git-badges";
import { PR_GLYPH_DISPLAY, prGlyphOf, prGlyphWords } from "@/components/pr-glyph-model";
import type { PrFacts } from "@/components/pr-marks-model";
import { ReviewStatusLabel, reviewStatusOf } from "@/components/review-glyph";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RingSpinner } from "@/motion";
import { parsePrRef } from "@/panels/review/pr-ref";
import { Notice, useReviewAction } from "@/panels/review/review-thread-card";
import { ToggleSwitch } from "@/panels/review/toggle-switch";
import { usePrDetailPrewarm } from "@/panels/use-pr-detail-prewarm";
import { useThreadsStore } from "@/stores/threads";

import { keepSamePrChecks, prChecksQuery } from "./pr-checks-query";
import { BranchLink, PrNumberLink, RepoLink } from "./pr-row-links";
import { usePrStripFold } from "./pr-strip-fold";
import {
  checkBuckets,
  extraRowsOf,
  foldedRows,
  prRowOf,
  stripLayout,
  type CheckBucketKind,
  type ExtraPrRow,
  type PrRow,
} from "./pr-strip-model";

const CHIP =
  "flex h-6 shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 text-xs tabular-nums outline-none";
const FOCUS = "focus-visible:ring-3 focus-visible:ring-ring/50";
const ROW =
  "flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card pr-1 pl-2.5 text-sm";
const QUIET =
  "flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground outline-none hover:text-foreground";
const MENU_ACTION =
  "flex items-center gap-2 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground disabled:opacity-50";
const POPUP =
  "flex w-72 origin-(--transform-origin) flex-col gap-2 rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";

const CHECKS_TONE: Record<ChecksRollup, string> = {
  passing: "text-success",
  failing: "text-destructive",
  pending: "text-warning",
  none: "text-muted-foreground",
};

const BUCKET_DISPLAY: Record<CheckBucketKind, { icon: LucideIcon; tone: string }> = {
  failed: { icon: CircleX, tone: "text-destructive" },
  running: { icon: RingSpinner, tone: "text-warning" },
  passed: { icon: CircleCheck, tone: "text-success" },
  skipped: { icon: Circle, tone: "text-muted-foreground" },
};

/**
 * The thread's pull requests as rows above the composer, its own first: state, then number,
 * repository and branch as three links of their own (a thread's PR needn't be its checkout's), then
 * the diff size, where the review bot stands, a CI menu and an × that hides the row without
 * unbinding it. More than one row folds behind "Show N more", per thread. Hidden rows wait behind
 * "N hidden" until something new needs the user, and then show even folded. Nothing while the
 * thread has no PR. The rows are drawn from the badge; only the menu's per-check counts are
 * fetched, and only for the focused pane, so a grid of threads doesn't multiply the GitHub requests.
 */
export function PrStrip({ threadId, focused }: { threadId: ThreadId; focused: boolean }) {
  const api = useApi();
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const hasPr = boundPr !== undefined || git?.pr !== undefined;
  const checksQuery = prChecksQuery(api, threadId, git, boundPr);
  const checks = useQuery({
    ...checksQuery,
    enabled: hasPr && focused,
    placeholderData: keepSamePrChecks(checksQuery.queryKey),
  });
  const extraPrs = useThreadsStore((s) => s.byId[threadId]?.thread.extraPrs);
  const hiddenPrs = useThreadsStore((s) => s.byId[threadId]?.thread.hiddenPrs);
  const expanded = usePrStripFold((s) => s.expanded.includes(threadId));
  const setExpanded = usePrStripFold((s) => s.setExpanded);
  const prewarm = usePrDetailPrewarm(threadId);
  const showHidden = useReviewAction();
  const { visible, hidden } = stripLayout(
    prRowOf(boundPr, git),
    extraRowsOf(extraPrs, git),
    hiddenPrs,
  );
  if (visible.length === 0 && hidden === 0) return null;
  const folded = foldedRows(visible);
  const more = visible.length - folded.length;
  const shown = expanded ? visible : folded;
  const hiddenLabel = `Show ${hidden} hidden ${hidden === 1 ? "PR" : "PRs"}`;

  return (
    <div
      data-testid="pr-strip"
      className="@container mx-auto flex w-full max-w-(--thread-max-width) shrink-0 flex-col gap-1 px-6 pb-2"
    >
      {shown.map((item) =>
        item.kind === "own" ? (
          <OwnRow
            key="own"
            threadId={threadId}
            row={item.row}
            runs={checks.data?.checks ?? []}
            prewarm={prewarm}
          />
        ) : (
          <ExtraRow
            key={`${item.row.fullRepo}#${item.row.number}`}
            threadId={threadId}
            row={item.row}
          />
        ),
      )}
      {(more > 0 || hidden > 0) && (
        <div className="flex items-center gap-2">
          {more > 0 && (
            <button
              type="button"
              data-testid="pr-strip-fold"
              aria-expanded={expanded}
              className={cn(QUIET, FOCUS)}
              onClick={() => setExpanded(threadId, !expanded)}
            >
              {expanded ? "Show less" : `Show ${more} more`}
            </button>
          )}
          {hidden > 0 && (
            <button
              type="button"
              data-testid="pr-strip-hidden"
              aria-label={hiddenLabel}
              title={showHidden.notice?.tone === "error" ? showHidden.notice.text : hiddenLabel}
              disabled={showHidden.pending}
              className={cn(QUIET, FOCUS, "disabled:opacity-50")}
              onClick={() =>
                void showHidden.run(async () => {
                  await api.prShowHidden(threadId);
                  return undefined;
                })
              }
            >
              <EyeOff aria-hidden className="size-3" />
              {hidden} hidden
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const hideLabel = (number: number) => `Hide #${number} from this thread's PR list`;

/** The thread's own PR: the bound one, else the branch's. Its number opens the PR panel. */
function OwnRow({
  threadId,
  row,
  runs,
  prewarm,
}: {
  threadId: ThreadId;
  row: PrRow;
  runs: Parameters<typeof checkBuckets>[0];
  prewarm: ReturnType<typeof usePrDetailPrewarm>;
}) {
  const api = useApi();
  const repo = row.fullRepo;
  return (
    <div data-testid="pr-row" className={ROW}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <StateIcon facts={row.facts} />
        <PrNumberLink
          number={row.number}
          facts={row.facts}
          place={row}
          card={row}
          title="Open the PR panel"
          onOpen={() => openPrPanel(threadId)}
          prewarm={prewarm}
        />
        <RepoLink threadId={threadId} place={row} />
        <BranchLink threadId={threadId} place={row} />
      </div>
      <DiffChip additions={row.additions} deletions={row.deletions} />
      <ReviewChip threadId={threadId} review={row.status?.review} />
      <CiMenu threadId={threadId} row={row} runs={runs} />
      {repo !== undefined && (
        <RowClose
          label={hideLabel(row.number)}
          run={() => api.prHide(threadId, hiddenEntryOf({ repo, number: row.number }, row.status))}
        />
      )}
    </div>
  );
}

/**
 * A PR the thread follows beside its own: its number opens GitHub, since the PR panel isn't about
 * it. It shows its title only until the badge says which branch it is.
 */
function ExtraRow({ threadId, row }: { threadId: ThreadId; row: ExtraPrRow }) {
  const api = useApi();
  return (
    <div data-testid="pr-row-extra" className={ROW}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <StateIcon facts={row.facts} />
        <PrNumberLink
          number={row.number}
          facts={row.facts}
          place={row}
          card={row}
          title={`Open #${row.number} on GitHub`}
          onOpen={() => void openExternalUrl(api, row.url)}
        />
        <RepoLink threadId={threadId} place={row} />
        {row.branch === undefined ? (
          row.title && <span className="truncate px-1 text-muted-foreground/80">{row.title}</span>
        ) : (
          <BranchLink threadId={threadId} place={row} />
        )}
      </div>
      <DiffChip additions={row.additions} deletions={row.deletions} />
      <ExtraCiMenu threadId={threadId} row={row} />
      <RowClose
        label={hideLabel(row.number)}
        run={() =>
          api.prHide(
            threadId,
            hiddenEntryOf({ repo: row.fullRepo, number: row.number }, row.status),
          )
        }
      />
    </div>
  );
}

function DiffChip({
  additions,
  deletions,
}: {
  additions: number | undefined;
  deletions: number | undefined;
}) {
  if (additions === undefined || deletions === undefined) return null;
  return (
    <span
      data-testid="pr-row-diff"
      className={CHIP}
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="text-success">+{formatCount(additions)}</span>
      <span className="text-destructive">−{formatCount(deletions)}</span>
    </span>
  );
}

/** Where the review bot stands on the PR; opens its findings. Nothing for a PR no bot has touched. */
function ReviewChip({
  threadId,
  review,
}: {
  threadId: ThreadId;
  review: PrReviewState | undefined;
}) {
  const status = reviewStatusOf(review);
  if (!status) return null;
  return (
    <button
      type="button"
      data-testid="pr-row-review"
      data-state={status.kind}
      aria-label={status.label}
      title={`${status.label}\nOpen the review`}
      className={cn(CHIP, FOCUS, "hover:bg-accent")}
      onClick={() => openPrReview(threadId)}
    >
      {/* A pane in a grid has no room for the words; the icon's colour and the label still say it. */}
      <ReviewStatusLabel status={status} textClassName="@max-lg:hidden" />
    </button>
  );
}

/** The row's one glyph (`prGlyphOf`), the sidebar's for the same PR; grey until the badge lands. */
function StateIcon({ facts }: { facts: PrFacts | undefined }) {
  if (!facts) {
    return <GitPullRequest aria-hidden className="mr-1 size-4 shrink-0 text-muted-foreground" />;
  }
  const glyph = prGlyphOf(facts);
  const display = PR_GLYPH_DISPLAY[glyph.kind];
  return (
    <display.icon
      role="img"
      aria-label={prGlyphWords(facts)}
      data-kind={glyph.kind}
      className={cn("mr-1 size-4 shrink-0", display.tone)}
    />
  );
}

function RowClose({ label, run }: { label: string; run: () => Promise<unknown> }) {
  const action = useReviewAction();
  return (
    <button
      type="button"
      aria-label={label}
      title={action.notice?.tone === "error" ? action.notice.text : label}
      disabled={action.pending}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-50",
        FOCUS,
      )}
      onClick={() =>
        void action.run(async () => {
          await run();
          return undefined;
        })
      }
    >
      <X aria-hidden className="size-3.5" />
    </button>
  );
}

/** The followed PR's CI menu: its one switch, the way to make it the thread's own PR, and unfollow. */
function ExtraCiMenu({ threadId, row }: { threadId: ThreadId; row: ExtraPrRow }) {
  const api = useApi();
  const action = useReviewAction();
  const tone = CHECKS_TONE[row.status?.checks ?? "none"];
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="pr-row-ci"
        aria-label={`CI monitoring for #${row.number}`}
        className={cn(CHIP, FOCUS, "hover:bg-accent")}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone)} />
        CI
        <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="pr-ci-menu"
            data-surface="overlay"
            aria-label="CI monitoring"
            className={POPUP}
          >
            <Toggle
              on={row.monitor}
              label="Watch CI"
              hint="Tell the agent when checks settle"
              disabled={action.pending}
              onToggle={() =>
                void action.run(async () => {
                  await api.prSetExtraMonitor(threadId, row.fullRepo, row.number, !row.monitor);
                  return undefined;
                })
              }
            />
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <button
                type="button"
                disabled={action.pending}
                className={cn(MENU_ACTION, FOCUS)}
                onClick={() =>
                  void action.run(async () => {
                    await api.prPromote(threadId, row.fullRepo, row.number);
                    return undefined;
                  })
                }
              >
                <ArrowUpToLine aria-hidden className="size-3.5" />
                Make #{row.number} this thread's PR
              </button>
              <button
                type="button"
                disabled={action.pending}
                className={cn(MENU_ACTION, FOCUS)}
                onClick={() =>
                  void action.run(async () => {
                    await api.prUnbindExtra(threadId, row.fullRepo, row.number);
                    return undefined;
                  })
                }
              >
                <Unlink aria-hidden className="size-3.5" />
                Stop following #{row.number}
              </button>
            </div>
            <Notice notice={action.notice} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CiMenu({
  threadId,
  row,
  runs,
}: {
  threadId: ThreadId;
  row: PrRow;
  runs: Parameters<typeof checkBuckets>[0];
}) {
  const api = useApi();
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const babysit = useThreadsStore((s) => s.byId[threadId]?.thread.babysit !== undefined);
  const origin = useThreadsStore((s) => s.byId[threadId]?.git?.origin);
  const action = useReviewAction();
  const buckets = checkBuckets(runs);
  const tone = CHECKS_TONE[row.status?.checks ?? "none"];
  const { url } = row;

  const watchCi = () =>
    action.run(async () => {
      if (boundPr) {
        await api.prSetMonitor(threadId, !boundPr.monitor);
        return undefined;
      }
      const repo = origin ?? (url === undefined ? undefined : parsePrRef(url)?.repo);
      if (repo === undefined) throw new Error("Couldn't tell which repository this PR is in");
      await api.prBind(threadId, repo, row.number, true);
      return undefined;
    });

  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="pr-row-ci"
        aria-label={`CI monitoring for #${row.number}`}
        className={cn(CHIP, FOCUS, "hover:bg-accent")}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone)} />
        CI
        <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-testid="pr-ci-menu"
            data-surface="overlay"
            aria-label="CI monitoring"
            className={POPUP}
          >
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              CI monitoring
              {url !== undefined && (
                <button
                  type="button"
                  aria-label={`Open #${row.number} on GitHub`}
                  title={`Open #${row.number} on GitHub`}
                  className={cn("rounded-sm p-0.5 outline-none hover:text-foreground", FOCUS)}
                  onClick={() => void openExternalUrl(api, url)}
                >
                  <ExternalLink aria-hidden className="size-3.5" />
                </button>
              )}
            </div>
            {buckets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No checks reported.</p>
            ) : (
              <ul aria-label="Checks" className="flex flex-col gap-1">
                {buckets.map((bucket) => {
                  const display = BUCKET_DISPLAY[bucket.kind];
                  return (
                    <li
                      key={bucket.kind}
                      data-testid="pr-ci-bucket"
                      className="flex items-center gap-2"
                    >
                      <display.icon aria-hidden className={cn("size-3.5", display.tone)} />
                      {bucket.label}
                      <span className="ml-auto text-muted-foreground tabular-nums">
                        {bucket.count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <Toggle
                on={boundPr?.monitor ?? false}
                label="Watch CI"
                hint="Tell the agent when checks settle"
                disabled={action.pending}
                onToggle={() => void watchCi()}
              />
              <Toggle
                on={boundPr?.reviewMonitor === true}
                label="Watch reviews"
                hint="Queue each bot round's findings"
                // Babysitting relies on the monitor; turn babysit off first.
                disabled={action.pending || babysit}
                onToggle={() =>
                  void action.run(async () => {
                    await api.threadSetReviewMonitor(threadId, boundPr?.reviewMonitor !== true);
                    return undefined;
                  })
                }
              />
              <Toggle
                on={babysit}
                label="Babysit this PR"
                hint="Fix CI and answer review comments"
                disabled={action.pending}
                onToggle={() =>
                  void action.run(async () => {
                    if (babysit) await api.threadSetBabysit(threadId, false);
                    else
                      await api.threadSetBabysit(threadId, true, {
                        rounds: DEFAULT_BABYSIT_ROUNDS,
                      });
                    return undefined;
                  })
                }
              />
            </div>
            {row.bound && (
              <button
                type="button"
                disabled={action.pending}
                className={cn(MENU_ACTION, "border-t border-border pt-2", FOCUS)}
                onClick={() =>
                  void action.run(async () => {
                    await api.prUnbind(threadId);
                    return undefined;
                  })
                }
              >
                <Unlink aria-hidden className="size-3.5" />
                Unbind #{row.number}
              </button>
            )}
            <Notice notice={action.notice} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Toggle({
  on,
  label,
  hint,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  hint: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <ToggleSwitch on={on} label={label} disabled={disabled} onToggle={onToggle} />
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{hint}</span>
      </div>
    </div>
  );
}
