import {
  prioritizeDigestReports,
  type DigestReport,
  type DreamReport,
  type FeatureGroupLedgerEntry,
  type FeatureLedgerEntry,
  type Handoff,
  type MemoryWrite,
  type OrchestrationDigest,
  type ThreadId,
  type WorkerAnswer,
  type WorkerLedgerEntry,
  type WorkerQuestion,
  type WorkerReport,
  isOpenQuestion,
  questionStatusLine,
} from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleX,
  ExternalLink,
  Layers,
  Megaphone,
  MessageCircleQuestion,
  MessageCircleReply,
  MoonStar,
  Network,
  NotebookPen,
  PackageCheck,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import { sectionsOf } from "@/orchestration/board-model";
import {
  dreamFailureText,
  verifiedDreamReport,
  dreamStatus,
  presentFileStatus,
  reviewSummary,
} from "@/orchestration/memory-model";
import { questionOutcome, workerQuestionCard } from "@/orchestration/question-card-model";
import { OpenQuestion, useWorkerQuestionActions } from "@/orchestration/question-entry";
import { StageChip } from "@/orchestration/stage-stepper";
import { OutboundLink } from "@/panels/outbound-link";
import { useThreadsStore } from "@/stores/threads";

import {
  budgetLine,
  budgetSpent,
  changeText,
  diffStat,
  digestTitle,
  formatBytes,
  handoffLabel,
  known,
  lineDiff,
  pauseText,
  prLabel,
  presentReportState,
  presentState,
  safeLink,
  workerFlags,
  type StatePresentation,
  type StateTone,
} from "./orchestration-model";
import { ThreadLinkedText } from "./thread-ref-link";

/** Each tone has its own icon shape, so a state never reads by colour alone. */
const TONE: Record<StateTone, { icon: LucideIcon; className: string }> = {
  muted: { icon: CircleDashed, className: "text-muted-foreground" },
  working: { icon: CircleDot, className: "text-status-working" },
  needs: { icon: CircleAlert, className: "text-status-needs" },
  success: { icon: CircleCheck, className: "text-success" },
  delivered: { icon: PackageCheck, className: "text-success" },
  danger: { icon: CircleX, className: "text-destructive" },
};

/** A tone's icon and colour; a tone this build doesn't know draws as the neutral one (`known`). */
const toneOf = (tone: string) => known(TONE, tone) ?? TONE.muted;

/** A state as its tone's icon and its label; `iconOnly` keeps the label for a tooltip and screen readers. */
export function StatePill({
  state,
  testId,
  iconOnly = false,
  className,
}: {
  state: StatePresentation;
  testId?: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const tone = toneOf(state.tone);
  return (
    <span
      data-testid={testId}
      title={iconOnly ? state.label : undefined}
      className={cn("inline-flex shrink-0 items-center gap-1 text-xs", tone.className, className)}
    >
      <Swap swapKey={state.label}>
        <tone.icon aria-hidden className="size-3" />
      </Swap>
      {iconOnly ? <span className="sr-only">{state.label}</span> : state.label}
    </span>
  );
}

const CARD = "rounded-(--radius-md) border border-border bg-card/40 p-3 text-sm";
const TRIGGER = "group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground";
const PRE = "mt-1 overflow-x-auto rounded-sm bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap";

function Disclosure({
  label,
  defaultOpen = false,
  children,
}: {
  label: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className={TRIGGER}>
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="gram-collapse">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function ThreadLink({ threadId, children }: { threadId: ThreadId; children: ReactNode }) {
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId }}
      className="min-w-0 truncate font-medium text-foreground underline-offset-4 hover:underline"
    >
      {children}
    </Link>
  );
}

/** A worker's PR: a link only when the address is one a browser should open. */
function PrLink({ url, children }: { url: string | undefined; children: ReactNode }) {
  const href = safeLink(url);
  if (href === undefined) return <span className="font-mono text-xs">{children}</span>;
  return (
    <OutboundLink
      href={href}
      className="inline-flex w-fit items-center gap-1 font-mono text-xs text-link underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </OutboundLink>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h4 className="text-xs font-medium text-muted-foreground">{children}</h4>;
}

/**
 * Worker-authored text: plain, never markdown, since it comes from an agent the user isn't watching.
 * Only its `[title](#threadId)` links to threads the app knows become chips.
 */
function WorkerText({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn("text-xs whitespace-pre-wrap", className)}>
      <ThreadLinkedText text={text} />
    </p>
  );
}

/**
 * "the orchestrator", linking to the one that spawned `worker` when the app knows it; plain words
 * when it doesn't.
 */
function OrchestratorOf({ worker, capital = false }: { worker: ThreadId; capital?: boolean }) {
  const words = capital ? "The orchestrator" : "the orchestrator";
  const orchestrator = useThreadsStore((s) => s.byId[worker]?.thread.spawnedBy?.threadId);
  const title = useThreadsStore((s) =>
    orchestrator === undefined ? undefined : s.byId[orchestrator]?.thread.title,
  );
  if (orchestrator === undefined || title === undefined) return <>{words}</>;
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: orchestrator }}
      title={title}
      className="underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
    >
      {words}
    </Link>
  );
}

function ReportItem({ report }: { report: DigestReport }) {
  const preview = report.summary.replaceAll(/\s+/g, " ").trim();
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
        <StatePill state={presentReportState(report.state)} />
        <span className="text-muted-foreground">{report.feature}</span>
        <ThreadLink threadId={report.threadId}>{report.title}</ThreadLink>
      </span>
      <WorkerText
        text={preview.length > 140 ? `${preview.slice(0, 140)}…` : preview}
        className="line-clamp-2"
      />
      {(preview.length > 140 || preview !== report.summary || report.interface !== undefined) && (
        <Disclosure label="Report evidence">
          <WorkerText text={report.summary} />
          {report.interface !== undefined && <WorkerText text={report.interface} />}
        </Disclosure>
      )}
      {report.prUrl !== undefined && <PrLink url={report.prUrl}>{report.prUrl}</PrLink>}
    </li>
  );
}

function WorkerRow({ worker }: { worker: WorkerLedgerEntry }) {
  const flags = workerFlags(worker);
  return (
    <tr className="border-t border-border/60 align-top">
      <td className="max-w-56 py-1 pr-3">
        <span className="flex min-w-0 flex-col">
          <ThreadLink threadId={worker.threadId}>{worker.title}</ThreadLink>
          <span className="truncate text-muted-foreground">{worker.project}</span>
          {worker.alsoIn !== undefined && worker.alsoIn.length > 0 && (
            <span
              data-testid="digest-also-in"
              className="text-muted-foreground"
              title={worker.alsoIn
                .map((repo) => (repo.pr === undefined ? repo.project : prLabel(repo.pr)))
                .join("\n")}
            >
              also in{" "}
              {worker.alsoIn
                .map((repo) =>
                  repo.pr === undefined ? repo.project : `${repo.project} #${repo.pr.number}`,
                )
                .join(", ")}
            </span>
          )}
        </span>
      </td>
      <td className="py-1 pr-3 whitespace-nowrap">
        <StatePill state={presentState(worker.state)} />
      </td>
      <td className="max-w-40 truncate py-1 pr-3 font-mono text-muted-foreground">
        {worker.branch ?? "–"}
      </td>
      <td className="py-1 pr-3 whitespace-nowrap">
        {worker.pr === undefined ? (
          <span className="text-muted-foreground">–</span>
        ) : (
          <PrLink url={worker.pr.url}>{prLabel(worker.pr)}</PrLink>
        )}
      </td>
      <td className={cn("py-1", flags.length > 0 ? "text-status-needs" : "text-muted-foreground")}>
        {flags.length === 0 ? "–" : flags.join(", ")}
      </td>
    </tr>
  );
}

function FeatureRows({ feature, grouped }: { feature: FeatureLedgerEntry; grouped: boolean }) {
  return (
    <tbody data-testid="digest-feature">
      <tr className="border-t border-border">
        <th scope="rowgroup" colSpan={5} className="pt-1.5 pb-0.5 font-medium">
          <span className={cn("flex min-w-0 flex-wrap items-center gap-2", grouped && "pl-3")}>
            {feature.feature}
            <StatePill state={presentState(feature.state)} />
            {feature.stage !== undefined && (
              <StageChip stage={feature.stage} testId="digest-feature-stage" className="max-w-48" />
            )}
          </span>
        </th>
      </tr>
      {feature.workers.map((worker) => (
        <WorkerRow key={worker.threadId} worker={worker} />
      ))}
    </tbody>
  );
}

function LedgerTable({
  features,
  groups,
}: {
  features: readonly FeatureLedgerEntry[];
  groups: readonly FeatureGroupLedgerEntry[] | undefined;
}) {
  const sections = sectionsOf(features, groups);
  return (
    <div className="mt-1 overflow-x-auto">
      <table data-testid="digest-ledger" className="w-full border-collapse text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="pr-3 pb-1 font-normal">
              Worker
            </th>
            <th scope="col" className="pr-3 pb-1 font-normal">
              State
            </th>
            <th scope="col" className="pr-3 pb-1 font-normal">
              Branch
            </th>
            <th scope="col" className="pr-3 pb-1 font-normal">
              PR
            </th>
            <th scope="col" className="pb-1 font-normal">
              Flags
            </th>
          </tr>
        </thead>
        {sections.groups.flatMap((group) => [
          <tbody key={`group:${group.group}`} data-testid="digest-group">
            <tr className="border-t border-border bg-muted/30">
              <th scope="rowgroup" colSpan={5} className="px-1 py-1 font-medium">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Layers aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  {group.group}
                  <StatePill state={presentState(group.state)} />
                  {group.stage !== undefined && (
                    <StageChip
                      stage={group.stage}
                      testId="digest-group-stage"
                      className="max-w-48"
                    />
                  )}
                </span>
              </th>
            </tr>
          </tbody>,
          ...group.rows.map((feature) => (
            <FeatureRows key={feature.feature} feature={feature} grouped />
          )),
        ])}
        {sections.ungrouped.map((feature) => (
          <FeatureRows key={feature.feature} feature={feature} grouped={false} />
        ))}
      </table>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A digest counts as just delivered for this long, which is when it animates in. */
const ARRIVAL_MS = 3000;

/**
 * The server's digest to an orchestrator, shown in place of the text the agent reads, where the
 * orchestrator's calm stream isn't (in its stream, a digest is a quiet line instead).
 */
export function OrchestrationDigestCard({
  digest,
  text,
  createdAt,
}: {
  digest: OrchestrationDigest;
  text: string;
  /** When the digest was delivered, epoch ms. */
  createdAt?: number | undefined;
}) {
  // Decided once, at mount: a digest that wakes the orchestrator while you watch arrives, and the
  // ones already in the transcript, or scrolled back into view, stay still.
  const [arriving] = useState(() => createdAt !== undefined && Date.now() - createdAt < ARRIVAL_MS);
  const title = digestTitle(digest);
  return (
    <article
      aria-label={title}
      data-testid="orchestration-digest"
      data-variant={digest.variant}
      className={cn(CARD, "flex w-full max-w-2xl flex-col gap-2.5", arriving && "gram-arrive")}
    >
      <header className="flex flex-wrap items-center gap-x-2">
        <Network aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">{digest.workspaceName}</span>
      </header>
      <DigestDetails digest={digest} text={text} />
    </article>
  );
}

/**
 * What a digest says, under the card's heading or a stream's digest line: why it woke the
 * orchestrator, what changed, the workers' reports (their own words, as plain text), the ledger,
 * the budget and the text the agent was sent. The ledger folds away while there are changes or
 * reports to read first.
 */
export function DigestDetails({ digest, text }: { digest: OrchestrationDigest; text: string }) {
  const workers = digest.features.reduce((n, feature) => n + feature.workers.length, 0);
  const news = digest.changes.length > 0 || digest.reports.length > 0;
  const lines = digest.notes.filter((note) => !note.includes("\n"));
  const blocks = digest.notes.filter((note) => note.includes("\n"));
  return (
    <>
      {digest.paused !== undefined && (
        <p
          data-testid="digest-paused"
          className="flex items-center gap-1 rounded-sm border border-status-needs/50 px-2 py-1 text-xs text-status-needs"
        >
          <CirclePause aria-hidden className="size-3.5 shrink-0" />
          {pauseText(digest.paused)}. Nothing is spawned or sent until you resume it.
        </p>
      )}
      {digest.reasons.length > 0 && (
        <p data-testid="digest-reasons" className="text-xs text-muted-foreground">
          Woken by: {digest.reasons.join(", ")}
        </p>
      )}
      {digest.changes.length > 0 && (
        <section aria-label="What changed" className="flex flex-col gap-1">
          <SectionHeading>What changed ({digest.changes.length})</SectionHeading>
          <ul data-testid="digest-changes" className="flex flex-col gap-0.5">
            {digest.changes.map((change) => (
              <li
                key={change.threadId}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs"
              >
                <span className="text-muted-foreground">{change.feature}</span>
                <ThreadLink threadId={change.threadId}>{change.title}</ThreadLink>
                <span className={toneOf(presentState(change.to).tone).className}>
                  {changeText(change)}
                </span>
                {change.note !== undefined && (
                  <span className="text-muted-foreground">({change.note})</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {lines.length > 0 && (
        <ul aria-label="Notes" className="flex list-disc flex-col gap-0.5 pl-4 text-xs">
          {lines.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {digest.reports.length > 0 && (
        <section aria-label="New worker reports" className="flex flex-col gap-1">
          <SectionHeading>New worker reports ({digest.reports.length})</SectionHeading>
          <ul data-testid="digest-reports" className="flex flex-col gap-2">
            {prioritizeDigestReports(digest.reports)
              .slice(0, 3)
              .map((report) => (
                <ReportItem key={`${report.threadId}:${report.at}`} report={report} />
              ))}
          </ul>
          {digest.reports.length > 3 && (
            <Disclosure label={`${digest.reports.length - 3} more reports`}>
              <ul className="flex flex-col gap-2">
                {prioritizeDigestReports(digest.reports)
                  .slice(3)
                  .map((report) => (
                    <ReportItem key={`${report.threadId}:${report.at}`} report={report} />
                  ))}
              </ul>
            </Disclosure>
          )}
        </section>
      )}
      {digest.features.length === 0 ? (
        <p className="text-xs text-muted-foreground">No workers yet.</p>
      ) : (
        <Disclosure
          defaultOpen={!news}
          label={`Ledger · ${plural(workers, "worker")} in ${plural(digest.features.length, "feature")}`}
        >
          <LedgerTable features={digest.features} groups={digest.groups} />
        </Disclosure>
      )}
      <p
        data-testid="digest-budget"
        className={cn(
          "text-xs tabular-nums",
          budgetSpent(digest.budget) ? "text-status-needs" : "text-muted-foreground",
        )}
      >
        {budgetLine(digest.budget)}
      </p>
      {blocks.map((note) => (
        <Disclosure key={note} label={note.slice(0, note.indexOf("\n")) || "Note"}>
          <pre className={PRE}>{note}</pre>
        </Disclosure>
      ))}
      <Disclosure label="Text sent to the agent">
        <pre data-testid="digest-text" className={PRE}>
          {text}
        </pre>
      </Disclosure>
    </>
  );
}

/** What a worker told its orchestrator with the `report` tool, in the worker's own transcript. */
export function WorkerReportCard({ report }: { report: WorkerReport }) {
  const state = presentReportState(report.state);
  return (
    <article
      aria-label={`Report to the orchestrator: ${state.label}`}
      data-testid="worker-report"
      className={cn(CARD, "my-2 flex flex-col gap-2")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Megaphone aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium">
          Reported to <OrchestratorOf worker={report.threadId} />
        </h3>
        <StatePill state={state} testId="worker-report-state" />
      </header>
      <WorkerText text={report.summary} className="text-sm" />
      {report.prUrl !== undefined && <PrLink url={report.prUrl}>{report.prUrl}</PrLink>}
      {report.interface !== undefined && (
        <Disclosure label="Interface for other workers">
          <pre data-testid="worker-report-interface" className={PRE}>
            {report.interface}
          </pre>
        </Disclosure>
      )}
    </article>
  );
}

const DIFF_LINE = {
  same: { mark: " ", className: "text-muted-foreground" },
  add: { mark: "+", className: "bg-success/10 text-success" },
  del: { mark: "−", className: "bg-destructive/10 text-destructive" },
} as const;

/** One change the orchestrator made to its memory, with the file's before and after. */
export function MemoryWriteCard({ write }: { write: MemoryWrite }) {
  const verb =
    write.action === "delete" ? "Deleted" : write.before === undefined ? "Created" : "Updated";
  const diff = lineDiff(write.before, write.after);
  return (
    <article
      aria-label={`Memory: ${verb.toLowerCase()} ${write.path}`}
      data-testid="memory-write"
      className={cn(CARD, "my-2 flex flex-col gap-2")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <NotebookPen aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium">Memory</h3>
        <span className="text-xs text-muted-foreground">{verb}</span>
        <span className="font-mono text-xs">{write.path}</span>
        {write.action === "write" && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(write.bytes)}
          </span>
        )}
      </header>
      {diff.length > 0 && (
        <Disclosure label={`Changes (${diffStat(diff)})`}>
          <pre
            data-testid="memory-diff"
            className="mt-1 overflow-x-auto rounded-sm bg-muted/40 py-1 font-mono text-xs"
          >
            {diff.map((line, i) => {
              const display = DIFF_LINE[line.kind];
              return (
                <span key={i} className={cn("block px-2 whitespace-pre-wrap", display.className)}>
                  {display.mark} {line.text}
                </span>
              );
            })}
          </pre>
        </Disclosure>
      )}
    </article>
  );
}

/** Where an orchestrator's agent session was replaced by a fresh one; looks like a chapter. */
export function HandoffDivider({ handoff }: { handoff: Handoff }) {
  return (
    <div
      data-testid="handoff"
      className="my-3 flex items-center gap-3 text-xs font-medium tracking-wide text-muted-foreground uppercase"
    >
      <span className="h-px flex-1 bg-border" />
      {handoffLabel(handoff)}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * An orchestrator answered a worker's question in the user's place, which only Full autonomy
 * allows. The same card stands in both transcripts, so what was said for the user is never out of
 * sight; both texts are an agent's own, shown as written.
 */
export function WorkerAnswerCard({
  answer,
  threadId,
}: {
  answer: WorkerAnswer;
  /** The thread the card is drawn in, which decides whose side of the exchange is named. */
  threadId: ThreadId;
}) {
  const inWorker = answer.threadId === threadId;
  const worker = useThreadsStore((s) => s.byId[answer.threadId]?.thread.title);
  return (
    <article
      aria-label="The orchestrator answered for you"
      data-testid="worker-answer"
      className={cn(CARD, "my-2 flex flex-col gap-1.5 p-2.5")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <MessageCircleReply aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium">
          {inWorker ? (
            <>
              <OrchestratorOf worker={answer.threadId} capital /> answered for you
            </>
          ) : (
            "The orchestrator answered for you"
          )}
        </h3>
        {!inWorker && (
          <span className="text-muted-foreground">
            to <ThreadLink threadId={answer.threadId}>{worker ?? "a worker"}</ThreadLink>
          </span>
        )}
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-sm">
        <dt className="text-xs text-muted-foreground">Q</dt>
        <dd>
          <WorkerText text={answer.question} />
        </dd>
        <dt className="text-xs text-muted-foreground">A</dt>
        <dd>
          <WorkerText text={answer.answer} />
        </dd>
      </dl>
      <p className="text-[11px] text-muted-foreground">
        Allowed because this workspace is at Full autonomy. Write to the{" "}
        {inWorker ? "worker" : "worker's thread"} if you would have said otherwise.
      </p>
    </article>
  );
}

/**
 * A worker's own question (`ask_question`), as one card that moves through its states: asked, with
 * the orchestrator, forwarded to you, answered or dismissed, with who did it and when. While it is
 * open it can be answered or dismissed right here too; the words are the worker's, as written.
 */
export function WorkerQuestionCard({
  question,
  threadId,
}: {
  question: WorkerQuestion;
  /** The thread the card is drawn in, which decides whose side is named. */
  threadId: ThreadId;
}) {
  const inWorker = question.threadId === threadId;
  const actions = useWorkerQuestionActions(question.workspaceId);
  const open = isOpenQuestion(question);
  const outcome = questionOutcome(question);
  const status = questionStatusLine(question);
  return (
    <article
      aria-label={`Question ${question.id}`}
      data-testid="worker-question-card"
      data-question={question.id}
      data-stage={question.stage}
      className={cn(CARD, "my-2 flex flex-col gap-1.5 p-2.5")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <MessageCircleQuestion
          aria-hidden
          className={cn("size-3.5", open ? "text-status-needs" : "text-muted-foreground")}
        />
        <h3 className="font-medium">
          {inWorker ? (
            <>Asked {question.id}</>
          ) : (
            <>
              {question.id} from{" "}
              <ThreadLink threadId={question.threadId}>{question.title}</ThreadLink>
            </>
          )}
        </h3>
        <span data-testid="question-status" className="ml-auto text-muted-foreground tabular-nums">
          {status}
        </span>
      </header>
      {open ? (
        <OpenQuestion
          card={{ ...workerQuestionCard(question), asker: undefined, status: undefined }}
          compact={false}
          onAnswer={actions.answer(question)}
          onDismiss={actions.dismiss(question)}
        />
      ) : (
        <>
          <WorkerText text={question.question} />
          {question.note !== undefined && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Orchestrator:</span> {question.note}
            </p>
          )}
          {outcome !== undefined && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-sm">
              <dt className="text-xs text-muted-foreground">
                {question.stage === "dismissed" ? "Why" : "A"}
              </dt>
              <dd data-testid="question-outcome">
                <WorkerText text={outcome} />
              </dd>
            </dl>
          )}
        </>
      )}
    </article>
  );
}

/** Where a dream ended, in the thread it ran as: what it changed in short, and the way to its review. */
export function DreamReportCard({
  report: storedReport,
  threadId,
}: {
  report: DreamReport;
  threadId: ThreadId;
}) {
  const report = verifiedDreamReport(storedReport);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.thread.workspaceId);
  const failure = dreamFailureText(report);
  const changed = report.files.filter((file) => file.status !== "unchanged");
  return (
    <article
      aria-label="Dream report"
      data-testid="dream-report"
      className={cn(CARD, "my-2 flex flex-col gap-2")}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MoonStar aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium">Dream</h3>
        <StatePill state={dreamStatus(report)} testId="dream-report-status" />
        <span className="text-xs text-muted-foreground">{reviewSummary(report.files)}</span>
      </header>
      {failure !== undefined && <p className="text-xs text-destructive">{failure}</p>}
      {changed.length > 0 && (
        <ul data-testid="dream-report-files" className="flex flex-col gap-0.5 text-xs">
          {changed.map((file) => (
            <li key={file.path} className="flex items-center gap-2">
              <span className="min-w-0 truncate font-mono">{file.path}</span>
              <StatePill state={presentFileStatus(file.status)} className="text-[11px]" />
            </li>
          ))}
        </ul>
      )}
      {report.reportExcerpt !== undefined && (
        <Disclosure label="Start of REPORT.md">
          <pre className={PRE}>{report.reportExcerpt}</pre>
        </Disclosure>
      )}
      {workspaceId !== undefined && (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <Link
            to="/w/$workspaceId/memory"
            params={{ workspaceId }}
            search={{ dream: report.dreamId }}
            data-testid="dream-report-review"
            className="rounded-sm font-medium text-foreground underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {report.mode === "auto"
              ? "Inspect in Memory"
              : report.status === "completed"
                ? "Review"
                : "Open in Memory"}
          </Link>
          {report.mode === "auto"
            ? report.adoptedVersion !== undefined
              ? `Automatically adopted as ${report.adoptedVersion}. Previous versions can be restored in Memory.`
              : report.adoptionFailure !== undefined
                ? "Automatic adoption stopped; check memory and kept versions."
                : "Auto mode applies only valid successful output."
            : report.status === "completed"
              ? "Nothing in memory changes until you adopt it there."
              : "It can only be discarded."}
        </p>
      )}
    </article>
  );
}
