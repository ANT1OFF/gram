import type { ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileDiff, Terminal, X } from "lucide-react";
import { useId, useMemo, type KeyboardEvent, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { Hint } from "@/components/hint";
import { PR_STATE_DISPLAY, prRefText } from "@/components/pr-marks-model";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/use-now";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { checkDuration, checkState } from "@/panels/pr-panel";
import { prDetailQuery, prDetailStamp } from "@/panels/pr-detail-query";
import { useCloseOnNavigate } from "@/settings/workspace-sheet";
import { useOpenThread } from "@/shell/thread-switcher";
import { useThreadFeed } from "@/stores/feeds";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { Dialog } from "@/thread/dialog-shell";

import { Kbd } from "./ask-choices";
import { detailFor, ledgerPrOf, prPeekOf, workerPeekOf, type PeekTone } from "./peek-model";
import { usePeekStore, type PeekTarget } from "./peek-store";
import { threadWorking } from "./tree-model";
import { useOrchestratorLedger } from "./use-orchestration";
import { workerEntryOf } from "./workers-model";

const PEEK_SHEET_TEST_ID = "peek-sheet";

const TONE: Record<NonNullable<PeekTone>, string> = {
  success: "text-success",
  danger: "text-destructive",
  pending: "text-status-working",
};

const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** Opens the worker's full view, in place of the sheet. */
function useOpenFull() {
  const open = useOpenThread();
  const close = usePeekStore((s) => s.close);
  return (threadId: ThreadId) => {
    close();
    open(threadId);
  };
}

/**
 * A worker or a PR in a sheet over the right of the pane it was opened from, a step short of the
 * worker's full view. It only
 * reads: it sends nothing and never holds the worker. Esc closes it and gives focus back; ⏎ on a
 * worker opens its full view.
 */
export function PeekSheet() {
  const open = usePeekStore((s) => s.open);
  const target = usePeekStore((s) => s.target);
  const container = usePeekStore((s) => s.container);
  const close = usePeekStore((s) => s.close);
  const opener = useOpener(open);
  const titleId = useId();
  const openFull = useOpenFull();
  useCloseOnNavigate(open, close);
  // In the pane while it is on the page, else over the window.
  const inPane = container?.isConnected === true;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || target?.kind !== "worker") return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea"))
      return;
    event.preventDefault();
    openFull(target.threadId);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal container={inPane ? container : undefined}>
        <Dialog.Backdrop
          className={cn(
            "inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            inPane ? "absolute" : "fixed",
          )}
        />
        <Dialog.Popup
          data-testid={PEEK_SHEET_TEST_ID}
          data-kind={target?.kind}
          data-thread-id={target?.threadId}
          data-surface="overlay"
          aria-labelledby={titleId}
          finalFocus={returnFocusTo(opener)}
          onKeyDown={onKeyDown}
          className={cn(
            "inset-y-2 end-2 z-50 flex w-[min(26rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-sm text-popover-foreground shadow-lg outline-none transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0",
            inPane ? "absolute" : "fixed",
          )}
        >
          {target?.kind === "worker" && (
            <WorkerPeekView
              target={target}
              titleId={titleId}
              onOpen={() => openFull(target.threadId)}
            />
          )}
          {target?.kind === "pr" && <PrPeekView target={target} titleId={titleId} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SheetHead({
  titleId,
  icon,
  children,
  actions,
}: {
  titleId: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const close = usePeekStore((s) => s.close);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      {icon}
      <Dialog.Title
        id={titleId}
        data-testid="peek-title"
        className="min-w-0 flex-1 truncate font-heading font-medium"
      >
        {children}
      </Dialog.Title>
      {actions}
      <Hint
        label="Close (Esc)"
        side="bottom"
        render={
          <button
            type="button"
            aria-label="Close"
            data-testid="peek-close"
            className={ICON_BUTTON}
            onClick={close}
          />
        }
      >
        <X aria-hidden className="size-3.5" />
      </Hint>
    </header>
  );
}

/** The ledger row of a worker, from its own workspace's ledger. */
function useLedgerEntry(threadId: ThreadId) {
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.thread.workspaceId);
  const { data: ledger } = useOrchestratorLedger(workspaceId);
  return workerEntryOf(ledger?.features, threadId);
}

function WorkerPeekView({
  target,
  titleId,
  onOpen,
}: {
  target: Extract<PeekTarget, { kind: "worker" }>;
  titleId: string;
  onOpen: () => void;
}) {
  const { threadId } = target;
  const title = useThreadsStore((s) => s.byId[threadId]?.thread.title) ?? target.title;
  // At work by the test every row's glyph takes: its turn, or work running under it.
  const running = useThreadsStore((s) => {
    const summary = s.byId[threadId];
    return summary !== undefined && threadWorking(summary, s.statusDetail[threadId]);
  });
  const entry = useLedgerEntry(threadId);
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const earlier = useThreadFeed(threadId, (s) => s.earlier);
  const peek = useMemo(() => workerPeekOf(messages, earlier, entry), [messages, earlier, entry]);
  return (
    <>
      <SheetHead
        titleId={titleId}
        icon={
          running ? (
            <Spinner aria-hidden className="size-3.5 shrink-0 text-status-working" />
          ) : (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          )
        }
        actions={
          <Button size="xs" variant="outline" data-testid="peek-open" onClick={onOpen}>
            Open
            <Kbd className="border-0 px-0">⏎</Kbd>
          </Button>
        }
      >
        {title}
        {entry !== undefined && (
          <span className="font-normal text-muted-foreground"> · {entry.project}</span>
        )}
      </SheetHead>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {peek.brief !== undefined && (
          <section data-testid="peek-brief" className="flex flex-col gap-0.5">
            <h4 className="text-xs text-muted-foreground">Brief</h4>
            <p className="line-clamp-4 whitespace-pre-line">{peek.brief}</p>
          </section>
        )}
        {(peek.files.length > 0 || peek.changedFiles !== undefined) && (
          <ul data-testid="peek-files" className="flex flex-col gap-0.5 font-mono text-xs">
            {peek.files.map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-1.5">
                <FileDiff aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">{file.path}</span>
                <span className="shrink-0 text-success">+{file.additions}</span>
                <span className="shrink-0 text-destructive">−{file.deletions}</span>
              </li>
            ))}
            {peek.moreFiles > 0 && (
              <li className="pl-4.5 text-muted-foreground">{peek.moreFiles} more</li>
            )}
            {peek.changedFiles !== undefined && (
              <li className="flex items-center gap-1.5 text-muted-foreground">
                <FileDiff aria-hidden className="size-3 shrink-0" />
                {peek.changedFiles === 1 ? "1 file changed" : `${peek.changedFiles} files changed`}
              </li>
            )}
          </ul>
        )}
        {peek.command !== undefined && (
          <p
            data-testid="peek-command"
            data-running={peek.command.running}
            className="flex min-w-0 items-center gap-1.5 font-mono text-xs"
          >
            <Terminal aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{peek.command.command}</span>
            {peek.command.running && (
              <Spinner aria-hidden className="size-3 shrink-0 text-status-working" />
            )}
          </p>
        )}
        {peek.report !== undefined && (
          <p data-testid="peek-report" className="line-clamp-4">
            {peek.report}
          </p>
        )}
        <p className="mt-auto text-xs text-muted-foreground">
          A peek. Open it to see the full transcript, its changes and its terminal.
        </p>
      </div>
    </>
  );
}

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="min-w-0">
        {children}
      </dd>
    </>
  );
}

function PrPeekView({
  target,
  titleId,
}: {
  target: Extract<PeekTarget, { kind: "pr" }>;
  titleId: string;
}) {
  const api = useApi();
  const { threadId } = target;
  const known = useThreadsStore((s) => s.byId[threadId] !== undefined);
  const stamp = useThreadsStore((s) =>
    prDetailStamp(s.byId[threadId]?.git, s.byId[threadId]?.thread.boundPr),
  );
  const entry = useLedgerEntry(threadId);
  // The PR panel's own query, so a peek and the panel share one fetch.
  const { data } = useQuery({ ...prDetailQuery(api, threadId, stamp), enabled: known });
  const detail = detailFor(data?.detail, target);
  const pr = prPeekOf(ledgerPrOf(entry, target), detail);
  const url = pr.url ?? target.url;
  const openFull = useOpenFull();
  const now = useNow(pr.runs.some((run) => checkState(run).spin === true));
  const merged = pr.state === "merged";
  // GitHub's shape for its state, and its colour only once merged.
  const Icon = PR_STATE_DISPLAY[pr.state ?? "open"].icon;
  return (
    <>
      <SheetHead
        titleId={titleId}
        icon={
          <Icon
            aria-hidden
            className={cn("size-3.5 shrink-0", merged ? "text-merged" : "text-status-working")}
          />
        }
      >
        {prRefText(target, { compact: true })}
        {pr.title !== undefined && <span className="font-normal"> {pr.title}</span>}
      </SheetHead>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {pr.checks !== undefined && (
            <Fact label="Checks" testId="peek-pr-checks">
              <span className={pr.checks.tone === undefined ? undefined : TONE[pr.checks.tone]}>
                {pr.checks.text}
              </span>
            </Fact>
          )}
          {pr.review !== undefined && (
            <Fact label="Review" testId="peek-pr-review">
              {pr.review}
            </Fact>
          )}
          {pr.waitsOn !== undefined && (
            <Fact label="Waits on" testId="peek-pr-waits">
              {pr.waitsOn}
            </Fact>
          )}
          {pr.change !== undefined && (
            <Fact label="Change" testId="peek-pr-change">
              <span className="text-success">+{pr.change.additions}</span>{" "}
              <span className="text-destructive">−{pr.change.deletions}</span> in{" "}
              {pr.change.files === 1 ? "1 file" : `${pr.change.files} files`}
            </Fact>
          )}
        </dl>
        {pr.runs.length > 0 && (
          <ul data-testid="peek-pr-runs" className="flex flex-col gap-0.5 text-xs">
            {pr.runs.map((run) => {
              const check = checkState(run);
              const duration = checkDuration(run, now);
              return (
                <li key={run.name} className="flex min-w-0 items-center gap-1.5">
                  <check.icon aria-label={check.label} className={cn("size-3.5", check.tone)} />
                  <span className="min-w-0 flex-1 truncate">{run.name}</span>
                  {duration !== undefined && (
                    <span className="shrink-0 text-muted-foreground tabular-nums">{duration}</span>
                  )}
                </li>
              );
            })}
            {pr.moreRuns > 0 && <li className="pl-5 text-muted-foreground">{pr.moreRuns} more</li>}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            data-testid="peek-pr-diff"
            onClick={() => {
              openFull(threadId);
              useLayoutStore.getState().revealPanel("diff", { thread: true });
            }}
          >
            <FileDiff aria-hidden />
            Diff
          </Button>
          <span className="flex-1" />
          {url !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              data-testid="peek-pr-github"
              onClick={() =>
                openExternalUrl(api, url).catch((error: unknown) =>
                  console.error("peek: open PR", error),
                )
              }
            >
              <ExternalLink aria-hidden />
              GitHub
            </Button>
          )}
        </div>
        {pr.note !== undefined && (
          <p data-testid="peek-pr-note" className="text-xs text-muted-foreground">
            {pr.note}
          </p>
        )}
      </div>
    </>
  );
}
