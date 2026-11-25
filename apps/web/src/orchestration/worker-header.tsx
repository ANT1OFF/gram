import type { Thread, ThreadId } from "@gram/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, SquareSplitHorizontal } from "lucide-react";

import { Hint } from "@/components/hint";
import { buttonVariants } from "@/components/ui/button";
import { focusOtherWindow } from "@/desktop/open-thread";
import { normaliseKeys } from "@/keyboard/bindings";
import { effectiveKeys } from "@/keyboard/bindings-store";
import { catalogKeys } from "@/keyboard/catalog";
import { keyLabel, useShortcut } from "@/keyboard/registry";
import { useNow } from "@/lib/use-now";
import { useTouch } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import { useThreadsStore } from "@/stores/threads";
import { RoleGlyph } from "@/thread/role-chip";
import { useOpenThread } from "@/shell/thread-switcher";

import { keepBeside, useBesideStore } from "./beside-store";
import { openFeatureSheet } from "./feature-sheet-store";
import { orchestratorRowTitle } from "./tree-model";
import { useOrchestratorLedger, useWorkspaces } from "./use-orchestration";
import { prWaitWords } from "./waiting-on";
import { goToThread } from "./worker-banner";
import { showWorkersTab } from "./workers-tab";
import { triagedQuestions, workerEntryOf, workerRow } from "./workers-model";

const denyTakesEsc = (): boolean => {
  const keys = effectiveKeys("approval.deny", catalogKeys("approval.deny") ?? "");
  return keys !== undefined && keys !== "" && normaliseKeys(keys) === normaliseKeys("escape");
};

export function useBackToOrchestrator(threadId: ThreadId, focused: boolean): void {
  const navigate = useNavigate();
  const orchestrator = useThreadsStore((s) => s.byId[threadId]?.thread.spawnedBy?.threadId);
  useShortcut(
    {
      id: "worker.back",
      keys: "escape",
      label: "Back to the orchestrator",
      group: "Navigation",
      when: () =>
        !(
          denyTakesEsc() &&
          useThreadsStore
            .getState()
            .byId[threadId]?.pendingRequests.some((request) => request.kind === "approval")
        ),
      run: () => {
        if (orchestrator === undefined || focusOtherWindow(orchestrator)) return;
        void navigate({ to: "/t/$threadId", params: { threadId: orchestrator } });
      },
    },
    focused && orchestrator !== undefined,
  );
}

const PARENT = "max-w-40 shrink-[6] font-normal text-muted-foreground";

const CRUMB =
  "min-w-0 truncate rounded-sm px-0.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function useWorkerFacts(thread: Thread | undefined) {
  const { data: ledger } = useOrchestratorLedger(thread?.workspaceId);
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  const now = useNow(true, undefined, 60_000);
  const entry = thread === undefined ? undefined : workerEntryOf(ledger?.features, thread.id);
  return {
    entry,
    row:
      entry === undefined
        ? undefined
        : workerRow(entry, { byId, statusDetail, now, triage: triagedQuestions(ledger) }),
  };
}

const crumbSeparator = (drop?: string) => (
  <ChevronRight aria-hidden className={cn("size-icon-chip shrink-0 text-subtle", drop)} />
);

/**
 * A worker's heading: "workspace › feature › worker". The workspace goes to the orchestrator, the
 * feature opens its sheet over the worker, and the worker's own name opens ⌘J's list of its siblings.
 * Opened from that list, the name glides here from its row. Short of room, the workspace and the
 * feature give way long before the worker's own name.
 */
export function WorkerCrumbs({
  thread,
  gestures,
  inTitlebar = false,
}: {
  thread: Thread;
  gestures: boolean;
  /** In the title bar, where a narrow header drops the crumbs above the worker whole. */
  inTitlebar?: boolean;
}) {
  const workspaces = useWorkspaces();
  const spawnedBy = thread.spawnedBy;
  const orchestrator = useThreadsStore((s) =>
    spawnedBy === undefined ? undefined : s.byId[spawnedBy.threadId]?.thread,
  );
  if (spawnedBy === undefined) return null;
  const workspace = workspaces.find((state) => state.workspace.id === thread.workspaceId);
  const workspaceName =
    workspace?.workspace.name ??
    (orchestrator === undefined ? "Orchestrator" : orchestratorRowTitle(orchestrator.title));
  const dropWorkspace = inTitlebar ? "hidden" : undefined;
  const dropFeature = inTitlebar ? "shrink-0 @max-md:hidden" : undefined;

  return (
    <h1
      aria-label={`Worker: ${thread.title}`}
      data-testid="worker-crumbs"
      className={cn(
        "flex items-center gap-1 font-heading font-medium",
        inTitlebar ? "min-w-18" : "min-w-0",
      )}
      title={
        gestures
          ? `${thread.title}. Double-click to maximize or restore; drag to swap panes`
          : thread.title
      }
    >
      <RoleGlyph thread={thread} testId="pane-role" />
      <nav aria-label="Worker path" className="flex min-w-0 items-center gap-1 text-reading">
        <Link
          to="/t/$threadId"
          params={{ threadId: spawnedBy.threadId }}
          data-testid="worker-crumb-workspace"
          className={cn(CRUMB, PARENT, dropWorkspace)}
          onClick={(event) => goToThread(spawnedBy.threadId, event)}
        >
          {workspaceName}
        </Link>
        {crumbSeparator(dropWorkspace)}
        {workspace === undefined ? (
          <span
            data-testid="worker-crumb-feature"
            className={cn("min-w-0 truncate", PARENT, dropFeature)}
          >
            {spawnedBy.feature}
          </span>
        ) : (
          <button
            type="button"
            data-testid="worker-crumb-feature"
            aria-haspopup="dialog"
            className={cn(CRUMB, PARENT, dropFeature)}
            onClick={() => openFeatureSheet(workspace.workspace.id, spawnedBy.feature)}
          >
            {spawnedBy.feature}
          </button>
        )}
        {crumbSeparator(dropFeature)}
        <Hint
          label="All workers"
          side="bottom"
          render={
            <button
              type="button"
              data-testid="worker-crumb-worker"
              data-titlebar-title=""
              className={cn(CRUMB, "text-foreground", inTitlebar && "min-w-12")}
              onClick={showWorkersTab}
            />
          }
        >
          {thread.title}
        </Hint>
      </nav>
    </h1>
  );
}

/**
 * Where a worker's PR stands while its turn is over and it waits on that PR ("waiting on checks"),
 * with the hover that lists every wait in full, from its ledger row; `undefined` while it runs, or
 * waits on anything else.
 */
export function useWorkerPrWait(
  thread: Thread | undefined,
): { words: string; hint: string | undefined } | undefined {
  const { row } = useWorkerFacts(thread);
  const words = prWaitOf(thread, row);
  return words === undefined ? undefined : { words, hint: row?.waiting?.hint };
}

const prWaitOf = (
  thread: Thread | undefined,
  row: ReturnType<typeof useWorkerFacts>["row"],
): string | undefined => {
  if (thread?.spawnedBy === undefined || row === undefined) return undefined;
  const turnOver = row.status !== "running" && row.status !== "starting";
  return turnOver && row.waiting !== undefined ? prWaitWords(row.waiting.kind) : undefined;
};

/**
 * The worker's now line beside its crumbs, the compact status ⌘J's rows show too. A worker whose
 * turn ended while its PR still waits says the two apart, "Turn: finished · PR: waiting on checks",
 * so a reply that says "Done." never reads against a header that says it is still waiting. While
 * the PR strip over the composer shows that PR (`prOnStrip`), the strip's row says where it stands
 * instead ("Waiting on checks") and this says nothing: the header, the title bar's most of all,
 * keeps to the worker's name and actions.
 */
export function WorkerNowChip({
  thread,
  prOnStrip = false,
}: {
  thread: Thread;
  prOnStrip?: boolean;
}) {
  const { row } = useWorkerFacts(thread);
  const pr = prWaitOf(thread, row);
  if (thread.spawnedBy === undefined || row === undefined) return null;
  if (pr !== undefined && prOnStrip) return null;
  if (pr !== undefined) {
    return (
      <span
        data-testid="worker-now-status"
        data-split=""
        title={row.waiting?.hint}
        className="inline-flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground"
      >
        <span data-testid="worker-turn-state" className="@max-md:hidden">
          Turn: <span className="text-foreground">finished</span>
          <span aria-hidden className="ml-1.5">
            ·
          </span>
        </span>
        <span data-testid="worker-pr-state">
          PR:{" "}
          <Swap swapKey={pr}>
            <span className="text-foreground">{pr}</span>
          </Swap>
        </span>
      </span>
    );
  }
  return (
    <span data-testid="worker-now-status" className="shrink-0 text-meta text-muted-foreground">
      <Swap swapKey={row.now}>{row.now}</Swap>
    </span>
  );
}

const HEADER_BUTTON = buttonVariants({ variant: "outline", size: "xs" });

const TITLEBAR_ICON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function useWorkerActions(thread: Thread) {
  const open = useOpenThread();
  const docked = useBesideStore((s) => s.worker === thread.id);
  const touch = useTouch();
  const orchestrator = useThreadsStore((s) =>
    thread.spawnedBy === undefined ? undefined : s.byId[thread.spawnedBy.threadId],
  );
  const worker = thread.spawnedBy !== undefined;
  return {
    worker,
    keepBeside:
      worker && orchestrator !== undefined && !docked && !touch
        ? () => keepBeside(thread.id, open)
        : undefined,
  };
}

/**
 * A worker's own action at the end of its header: Open beside shows it in the right panel next to
 * its orchestrator's chat. In the title bar it is the panels' group's instead
 * (`TitlebarOpenBeside`), so nothing is drawn here.
 */
export function WorkerActions({
  thread,
  inTitlebar = false,
}: {
  thread: Thread;
  /** In the title bar, where Open beside is the panels' group's rather than this. */
  inTitlebar?: boolean;
}) {
  const actions = useWorkerActions(thread);
  if (!actions.worker || inTitlebar || actions.keepBeside === undefined) return null;
  return (
    <Hint
      label={keyLabel("Open beside the chat (⌘\\)")}
      side="bottom"
      render={
        <button
          type="button"
          data-testid="worker-keep-beside"
          className={HEADER_BUTTON}
          onClick={actions.keepBeside}
        />
      }
    >
      <SquareSplitHorizontal aria-hidden className="size-icon-row" />
      <span className="@max-md:sr-only">Open beside</span>
    </Hint>
  );
}

/**
 * A worker's Open beside in the title bar: an icon beside the right panel's toggle, the two controls
 * that put something in that panel, grouped at the bar's end. Its words and key are on hover.
 * Nothing on a thread that isn't a worker, or one already beside its orchestrator.
 */
export function TitlebarOpenBeside({ threadId }: { threadId: ThreadId | undefined }) {
  const thread = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread,
  );
  if (thread?.spawnedBy === undefined) return null;
  return <OpenBesideIcon thread={thread} />;
}

function OpenBesideIcon({ thread }: { thread: Thread }) {
  const open = useWorkerActions(thread).keepBeside;
  if (open === undefined) return null;
  return (
    <Hint
      label={keyLabel("Open beside the chat (⌘\\)")}
      side="bottom"
      render={
        <button
          type="button"
          aria-label="Open beside the chat"
          data-testid="worker-keep-beside"
          className={cn(TITLEBAR_ICON, "[-webkit-app-region:no-drag]")}
          onClick={open}
        />
      }
    >
      <SquareSplitHorizontal aria-hidden className="size-icon-bar" />
    </Hint>
  );
}
