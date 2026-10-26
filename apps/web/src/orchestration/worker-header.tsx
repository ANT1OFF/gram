import { USER_HOLD_IDLE_MS, type Thread, type ThreadId } from "@gram/contracts";
import { Menu } from "@base-ui/react/menu";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Hand, PanelRight } from "lucide-react";

import { Hint } from "@/components/hint";
import { focusOtherWindow } from "@/desktop/open-thread";
import { useShortcut } from "@/keyboard/registry";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { GlideText, Swap } from "@/motion";
import { useThreadsStore } from "@/stores/threads";
import { RoleGlyph } from "@/thread/role-chip";
import { useOpenThread } from "@/shell/thread-switcher";
import { Foldable } from "@/shell/titlebar-fold";
import { FOLD_ALL, useTitlebarSlot } from "@/shell/titlebar-slot";
import { useThreadActions } from "@/thread/use-thread-actions";

import { keepBeside, useBesideStore } from "./beside-store";
import { openFeatureSheet } from "./feature-sheet-store";
import { orchestratorRowTitle } from "./tree-model";
import { useOrchestratorLedger, useWorkspaces } from "./use-orchestration";
import { goToThread } from "./worker-banner";
import { workerGlideId, useWorkersListStore } from "./workers-list";
import { workerEntryOf, workerRow } from "./workers-model";

/**
 * Esc on a worker goes back to its orchestrator, one level up, as the workspace crumb does. Only
 * while nothing else has Esc: the registry already keeps a plain key from a field being typed in
 * (an empty composer too) and from a dialog, an open menu closes on its own Esc first, and an
 * approval card's Esc denies it, so a worker with one waiting keeps that.
 */
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
        !useThreadsStore
          .getState()
          .byId[threadId]?.pendingRequests.some((request) => request.kind === "approval"),
      run: () => {
        if (orchestrator === undefined || focusOtherWindow(orchestrator)) return;
        void navigate({ to: "/t/$threadId", params: { threadId: orchestrator } });
      },
    },
    focused && orchestrator !== undefined,
  );
}

/** A crumb above the worker: muted, capped, and the first to give way. */
const PARENT = "max-w-40 shrink-[6] font-normal text-muted-foreground";

const CRUMB =
  "min-w-0 truncate rounded-sm px-0.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A worker's ledger row and its live now line, while workspaces are on and the ledger is in. */
function useWorkerFacts(thread: Thread) {
  const { data: ledger } = useOrchestratorLedger(thread.workspaceId);
  const byId = useThreadsStore((s) => s.byId);
  const statusDetail = useThreadsStore((s) => s.statusDetail);
  const now = useNow(true, undefined, 60_000);
  const entry = workerEntryOf(ledger?.features, thread.id);
  return {
    entry,
    row: entry === undefined ? undefined : workerRow(entry, { byId, statusDetail, now }),
  };
}

/** The › between crumbs, dropped with the crumb before it. */
const crumbSeparator = (drop?: string) => (
  <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-muted-foreground/60", drop)} />
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
  const gliding = useWorkersListStore((s) => s.gliding === thread.id);
  const spawnedBy = thread.spawnedBy;
  const orchestrator = useThreadsStore((s) =>
    spawnedBy === undefined ? undefined : s.byId[spawnedBy.threadId]?.thread,
  );
  if (spawnedBy === undefined) return null;
  const workspace = workspaces.find((state) => state.workspace.id === thread.workspaceId);
  const workspaceName =
    workspace?.workspace.name ??
    (orchestrator === undefined ? "Orchestrator" : orchestratorRowTitle(orchestrator.title));
  // In the title bar the switcher beside it names the workspace, and Esc goes back up to its
  // orchestrator. A crumb cut to a letter or two says nothing, so narrow the feature drops whole.
  const dropWorkspace = inTitlebar ? "hidden" : undefined;
  // Wider, it stays whole up to its cap and the worker's own name truncates instead.
  const dropFeature = inTitlebar ? "shrink-0 @max-md:hidden" : undefined;

  return (
    <h1
      aria-label={`Worker: ${thread.title}`}
      data-testid="worker-crumbs"
      // In the title bar it never shrinks past the worker's few letters.
      className={cn(
        "flex items-center gap-1 font-heading font-medium",
        inTitlebar ? "min-w-18" : "min-w-0",
      )}
      title={
        gestures
          ? `${thread.title}. Double-click to maximize or restore; drag to swap panes`
          : undefined
      }
    >
      <RoleGlyph thread={thread} testId="pane-role" />
      <nav aria-label="Worker path" className="flex min-w-0 items-center gap-1 text-sm">
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
              // In the title bar the worker's name keeps a few letters, however short of room.
              className={cn(CRUMB, "text-foreground", inTitlebar && "min-w-12")}
              onClick={() => useWorkersListStore.getState().toggle()}
            />
          }
        >
          <GlideText glideId={gliding ? workerGlideId(thread.id) : undefined}>
            {thread.title}
          </GlideText>
        </Hint>
      </nav>
    </h1>
  );
}

/** The worker's now line beside its crumbs, the compact status ⌘J's rows show too. */
export function WorkerNowChip({ thread }: { thread: Thread }) {
  const { row } = useWorkerFacts(thread);
  if (thread.spawnedBy === undefined || row === undefined) return null;
  return (
    <span data-testid="worker-now-status" className="shrink-0 text-xs text-muted-foreground">
      <Swap swapKey={row.now}>{row.now}</Swap>
    </span>
  );
}

/**
 * "You hold it", while the user holds the worker (they typed into it, or started it themselves):
 * the orchestrator can't message it until they hand it back. Watching it never holds it.
 */
function HoldChip({
  thread,
  compact = false,
  ghost = false,
}: {
  thread: Thread;
  compact?: boolean;
  /** The unseen copy a folded title bar measures, with no test ids of its own. */
  ghost?: boolean;
}) {
  const { entry } = useWorkerFacts(thread);
  const { release } = useThreadActions(thread.id);
  if (thread.spawnedBy === undefined || entry?.userIntervened !== true) return null;
  return (
    <span
      data-testid={ghost ? undefined : "worker-hold"}
      role="status"
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-status-needs/40 bg-status-needs/10 pl-1 text-xs text-foreground"
    >
      <Hint
        label={`The orchestrator can't message it until you hand it back. It comes back by itself at its next report, or ${USER_HOLD_IDLE_MS / 60_000} minutes after your last message once idle.`}
        side="bottom"
        render={
          <span
            data-testid={ghost ? undefined : "worker-hold-words"}
            className="inline-flex items-center gap-1"
          />
        }
      >
        <Hand aria-hidden className="size-3 text-status-needs" />
        <span className={cn(compact && "sr-only")}>You hold it</span>
      </Hint>
      <button
        type="button"
        data-testid={ghost ? undefined : "worker-hand-back"}
        className="rounded-r-sm border-l border-status-needs/40 px-1 font-medium outline-none hover:bg-status-needs/20 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={release}
      >
        Hand back
      </button>
    </span>
  );
}

const HEADER_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 text-xs text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A worker's end states, where there is nothing left to take over. */
const FINISHED = new Set(["merged", "delivered", "archived"]);

/** What a worker's own actions can do now: dock beside its orchestrator, or be taken over. */
function useWorkerActions(thread: Thread) {
  const { entry } = useWorkerFacts(thread);
  const { takeOver } = useThreadActions(thread.id);
  const open = useOpenThread();
  const docked = useBesideStore((s) => s.worker === thread.id);
  const orchestrator = useThreadsStore((s) =>
    thread.spawnedBy === undefined ? undefined : s.byId[thread.spawnedBy.threadId],
  );
  const worker = thread.spawnedBy !== undefined;
  const held = entry?.userIntervened === true;
  return {
    worker,
    held,
    keepBeside:
      worker && orchestrator !== undefined && !docked
        ? () => keepBeside(thread.id, open)
        : undefined,
    takeOver:
      worker && !held && entry !== undefined && !FINISHED.has(entry.state)
        ? () => void takeOver()
        : undefined,
  };
}

/**
 * A worker's own actions at the end of its header: Keep beside docks it next to its orchestrator's
 * chat (⌘\), and Take over holds it for you, by the same path a message you type into it takes,
 * until you hand it back. While you hold it, the hold chip and its Hand back stand in Take over's
 * place. Watching it, here or beside the chat, never holds it. In a title bar folded all the way,
 * Keep beside and Take over are the thread menu's (`WorkerMenuItems`) and the hold chip is a glyph
 * and its Hand back.
 */
export function WorkerActions({
  thread,
  inTitlebar = false,
}: {
  thread: Thread;
  /** In the title bar, where Keep beside is its glyph, its words in the tooltip. */
  inTitlebar?: boolean;
}) {
  const actions = useWorkerActions(thread);
  const folded = useTitlebarSlot((s) => inTitlebar && s.fold >= FOLD_ALL);
  if (!actions.worker) return null;
  const all = (ghost: boolean) => (
    <>
      {actions.keepBeside !== undefined && (
        <Hint
          label="Keep beside the chat (⌘\\)"
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
          <PanelRight aria-hidden className="size-3" />
          <span className={inTitlebar ? "sr-only" : "@max-md:sr-only"}>Keep beside</span>
        </Hint>
      )}
      {actions.held ? (
        <HoldChip thread={thread} ghost={ghost} />
      ) : (
        actions.takeOver !== undefined && (
          <Hint
            label="Hold it for you, as typing to it would"
            side="bottom"
            render={
              <button
                type="button"
                data-testid="worker-take-over"
                className={HEADER_BUTTON}
                onClick={actions.takeOver}
              />
            }
          >
            Take over
          </Hint>
        )
      )}
    </>
  );
  if (!inTitlebar) return all(false);
  // A narrow title bar folds them into the thread menu, and the hold chip down to its glyph.
  return (
    <>
      {folded && actions.held && <HoldChip thread={thread} compact />}
      <Foldable level={FOLD_ALL} gap={8} className="gap-2">
        {all(folded)}
      </Foldable>
    </>
  );
}

/** Keep beside and Take over as the thread menu's items, while a narrow title bar folds them. */
export function WorkerMenuItems({
  thread,
  itemClassName,
}: {
  thread: Thread;
  itemClassName: string;
}) {
  const actions = useWorkerActions(thread);
  if (actions.keepBeside === undefined && actions.takeOver === undefined) return null;
  return (
    <>
      {actions.keepBeside !== undefined && (
        <Menu.Item
          data-testid="menu-keep-beside"
          className={itemClassName}
          onClick={actions.keepBeside}
        >
          <PanelRight aria-hidden className="size-3.5" />
          Keep beside
        </Menu.Item>
      )}
      {actions.takeOver !== undefined && (
        <Menu.Item
          data-testid="menu-take-over"
          className={itemClassName}
          onClick={actions.takeOver}
        >
          <Hand aria-hidden className="size-3.5" />
          Take over
        </Menu.Item>
      )}
      <div role="separator" className="-mx-1 my-1 h-px bg-border" />
    </>
  );
}
