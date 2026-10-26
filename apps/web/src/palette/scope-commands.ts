import type { MessageId, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { isWorktreeCheckout } from "@/components/branch-chip";
import { usePushBranch } from "@/components/push-button";
import { openInNewWindow } from "@/desktop/open-in-new-window";
import { focusOtherWindow } from "@/desktop/open-thread";
import {
  revealLabel,
  useOpenInEditor,
  useOpensLocally,
  useRevealInFileManager,
} from "@/editor/use-open-in-editor";
import { shortcutHint } from "@/keyboard/bindings";
import { tidyUpBlocked } from "@/orchestration/board-model";
import { useOpenBoard } from "@/orchestration/open-board";
import { setWorkspacePaused } from "@/orchestration/pause-workspace";
import { sendTidyUp } from "@/orchestration/use-board-actions";
import { useOrchestratorLedger, useWorkspaces } from "@/orchestration/use-orchestration";
import { removeWorkspaceRepo } from "@/orchestration/workspace-repos";
import { removableRepos } from "@/settings/workspace-settings-model";
import { feedLoaded, feedMessages } from "@/stores/feeds";
import { useLayoutStore, type PaletteScope } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { branchDeleteLooksSafe, mergedPrRef } from "@/thread/merged-cleanup";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { copyMarkdown } from "@/thread/message-actions";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { JOIN_NEEDS_WORKTREE, useThreadActions } from "@/thread/use-thread-actions";
import {
  checkoutInUse,
  forkErrorMessage,
  openForkedThread,
  useForkAvailability,
  WORKTREE_NOTICE,
} from "@/thread/use-fork";
import { useThreadWakes } from "@/thread/wake-chip";

import type { PaletteItem, PaletteSection } from "./palette-items";

/** The palette's own steps a scoped command hands back to: lists that need the palette's state. */
export interface ScopeSteps {
  /** "Open in pane…" for one thread: its panes to pick from. */
  pickPane(threadId: ThreadId): void;
  /** "Reopen Waiting on you item…": the thread's resolved items. */
  reopenWaits(threadId: ThreadId): void;
}

export interface ScopeCommands {
  /** What the scope chip names: the thread's title or the workspace's name. */
  readonly title: string | undefined;
  readonly sections: readonly PaletteSection[];
}

const NO_THREAD = "" as ThreadId;

const shortcut = (id: string) => {
  const keys = shortcutHint(id);
  return keys === "" ? {} : { shortcut: keys };
};

/**
 * Every command of one thread or workspace: what a context menu's More… lists, and what `>` matches
 * for the thread and workspace in view. A workspace's own orchestrator thread brings its thread
 * commands along; a worker's brings the way to its orchestrator and board.
 */
export function useScopeCommands(
  scope: PaletteScope | undefined,
  steps: ScopeSteps,
): ScopeCommands {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openBoard = useOpenBoard();
  const workspaces = useWorkspaces();
  const byId = useThreadsStore((s) => s.byId);

  const scopedWorkspace =
    scope?.kind === "workspace"
      ? workspaces.find((state) => state.workspace.id === scope.workspaceId)
      : undefined;
  const orchestratorId = scopedWorkspace?.workspace.orchestratorThreadId;
  const threadId =
    scope?.kind === "thread"
      ? scope.threadId
      : orchestratorId !== undefined && byId[orchestratorId] !== undefined
        ? orchestratorId
        : undefined;
  const summary = threadId === undefined ? undefined : byId[threadId];
  const thread = summary?.thread;
  const actions = useThreadActions(threadId ?? NO_THREAD);
  const wakes = useThreadWakes(threadId ?? NO_THREAD);
  const fork = useForkAvailability(threadId ?? NO_THREAD);
  const pushing = usePushBranch(threadId ?? NO_THREAD);
  const local = useOpensLocally();
  const openInEditor = useOpenInEditor();
  const revealInFileManager = useRevealInFileManager();
  // A worker's workspace, for its ways back; held workers are in the ledger.
  const workerWorkspace =
    scope?.kind === "thread" && thread?.spawnedBy !== undefined
      ? workspaces.find((state) => state.workspace.id === thread.workspaceId)
      : undefined;
  const { data: ledger } = useOrchestratorLedger(workerWorkspace?.workspace.id);
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
    enabled: scopedWorkspace !== undefined,
  });

  const open = useThreadDialogs((s) => s.open);
  const fail = useThreadDialogs((s) => s.fail);
  const attempt = (what: string, run: Promise<unknown>) =>
    void run.catch((error: unknown) => fail(`Couldn't ${what}: ${errorMessage(error)}`));
  const goTo = (id: ThreadId) => {
    if (focusOtherWindow(id)) return;
    useLayoutStore.getState().openThread(id);
    void navigate({ to: "/t/$threadId", params: { threadId: id } });
  };
  const board = (workspaceId: WorkspaceId): PaletteItem => ({
    id: `scope:board:${workspaceId}`,
    label: "Open board",
    ...shortcut("orchestration.board"),
    keywords: "workspace workers features approvals kanban orchestration",
    run: () => openBoard(workspaceId),
  });

  const threadSections: PaletteSection[] = [];
  if (thread !== undefined) {
    const id = thread.id;
    const current = thread.labels[0];
    const source = thread.forkedFrom?.threadId;
    const worker = thread.role !== "orchestrator";
    const lastReply = feedLoaded(id)
      ? feedMessages(id).findLast(
          (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.trim()),
        )
      : undefined;
    threadSections.push({
      id: "thread",
      label: "Thread",
      items: [
        {
          id: `scope:open:${id}`,
          label: "Open thread",
          run: () => goTo(id),
        },
        {
          id: `scope:rename:${id}`,
          label: "Rename thread…",
          ...shortcut("thread.rename"),
          run: actions.rename,
        },
        {
          id: `scope:pin:${id}`,
          label: thread.pinned ? "Unpin thread" : "Pin thread",
          run: actions.togglePin,
        },
        {
          id: `scope:park:${id}`,
          label: thread.parked ? "Unpark thread" : "Park thread",
          run: actions.togglePark,
        },
        {
          id: `scope:label:${id}`,
          label: "Label…",
          keywords: "tag colour color",
          run: () => {},
          opens: () => ({
            title: "Label",
            items: [
              ...actions.labels.map((label) => ({
                id: `label:${label.id}`,
                label: label.name,
                ...(current === label.id ? { hint: "Current" } : {}),
                run: () => actions.setLabel(label.id),
              })),
              { id: "label:none", label: "No label", run: () => actions.setLabel(undefined) },
              { id: "label:edit", label: "Edit labels…", run: actions.editLabels },
            ],
          }),
        },
        {
          id: `scope:fork:${id}`,
          label: "Fork thread",
          keywords: "copy branch duplicate",
          ...(fork.available
            ? {}
            : { unavailable: fork.reason ?? "This thread can't be forked now" }),
          run: () =>
            void api.forkThread(id, {}).then(
              (forked) => {
                openForkedThread(forked);
                void navigate({ to: "/t/$threadId", params: { threadId: forked.id } });
              },
              (error: unknown) => {
                if (checkoutInUse(error)) {
                  open({ kind: "fork", threadId: id, notice: WORKTREE_NOTICE });
                } else fail(forkErrorMessage(error));
              },
            ),
        },
        {
          id: `scope:forkWorktree:${id}`,
          label: "Fork into worktree…",
          keywords: "copy branch duplicate checkout",
          ...(fork.available
            ? {}
            : { unavailable: fork.reason ?? "This thread can't be forked now" }),
          run: () => open({ kind: "fork", threadId: id }),
        },
        ...(source !== undefined && byId[source] !== undefined
          ? [{ id: `scope:source:${id}`, label: "Go to source thread", run: () => goTo(source) }]
          : []),
        {
          id: `scope:restart:${id}`,
          label: "Restart session",
          keywords: "reload config mcp connectors settings claude.md agents.md skills cli refresh",
          run: actions.restartSession,
        },
        ...(actions.freshSession === undefined
          ? []
          : [
              {
                id: `scope:fresh:${id}`,
                label: "Fresh session…",
                keywords: "handoff new session context compact orchestrator memory",
                run: actions.freshSession,
              },
            ]),
        // Only while a view of the thread has its messages: a thread no pane shows has no reply
        // here to add.
        ...(lastReply === undefined
          ? []
          : [
              {
                id: `scope:addWait:${id}`,
                label: "Add reply to Waiting on you",
                keywords: "waiting on you draft keep remind later todo last",
                run: () => {
                  const kept = useThreadsStore
                    .getState()
                    .byId[id]?.waits?.some((item) => item.messageId === lastReply.id);
                  if (kept === true) fail("The last reply already waits on you.");
                  else {
                    attempt("add it to Waiting on you", api.addWait(id, lastReply.id as MessageId));
                  }
                },
              },
            ]),
        {
          id: `scope:reopenWait:${id}`,
          label: "Reopen Waiting on you item…",
          keywords: "waiting on you undo resolved done reopen",
          stay: true,
          run: () => steps.reopenWaits(id),
        },
        ...(wakes.length === 0
          ? []
          : [
              {
                id: `scope:cancelWakes:${id}`,
                label: wakes.length === 1 ? "Cancel wake" : `Cancel ${wakes.length} wakes`,
                keywords: "alarm schedule timer",
                run: () => attempt("cancel the wake", api.cancelThreadWake(id)),
              },
            ]),
        {
          id: `scope:close:${id}`,
          label: "Close thread…",
          ...shortcut("thread.close"),
          run: actions.close,
        },
      ],
    });
    threadSections.push({
      id: "window",
      label: "Window",
      items: [
        {
          id: `scope:openInPane:${id}`,
          label: "Open in pane…",
          stay: true,
          run: () => steps.pickPane(id),
        },
        {
          id: `scope:newWindow:${id}`,
          label: "Open in new window",
          ...shortcut("window.openThread"),
          run: () => void openInNewWindow(id),
        },
        ...(local
          ? [
              {
                id: `scope:editor:${id}`,
                label: "Open folder in editor",
                keywords: "code ide vscode",
                run: () => void openInEditor(thread.checkout.path, { threadId: id }),
              },
              {
                id: `scope:reveal:${id}`,
                label: revealLabel(),
                keywords: "finder explorer file manager folder",
                run: () => void revealInFileManager(thread.checkout.path, { threadId: id }),
              },
            ]
          : []),
        {
          id: `scope:worktrees:${id}`,
          label: "Worktrees…",
          keywords: "remove unused checkout",
          run: () =>
            open({
              kind: "worktrees",
              repoPath: thread.checkout.repoRoot ?? thread.checkout.path,
            }),
        },
      ],
    });
    // The branch is the agents' working detail: kept out of the bar and the thread menu, here.
    const branch = summary?.git?.branch ?? thread.checkout.branch;
    if (branch) {
      // Which checkout it is, to find it by, as the branch chip's glyph tells it.
      const worktree = isWorktreeCheckout(thread, summary?.git);
      threadSections.push({
        id: "branch",
        label: "Branch",
        items: [
          {
            id: `scope:copyBranch:${id}`,
            label: `Copy ${branch}`,
            keywords: `git branch name ${worktree ? "worktree" : "shared checkout"}`,
            run: () => void copyMarkdown(branch, { toast: true }),
          },
          ...(pushing.action === undefined
            ? []
            : [
                {
                  id: `scope:push:${id}`,
                  label: pushing.label ?? "Push",
                  keywords: `git push publish upstream origin ${branch}`,
                  ...(pushing.pending ? { unavailable: pushing.pendingLabel } : {}),
                  run: () => void pushing.push(),
                },
              ]),
        ],
      });
    }
    // An orchestrator follows no PR of its own; its workers carry theirs.
    if (worker) {
      threadSections.push({
        id: "pr",
        label: "Pull request",
        items: [
          ...(thread.boundPr
            ? [
                {
                  id: `scope:unbindPr:${id}`,
                  label: `Unbind #${thread.boundPr.number}`,
                  keywords: `pr pull request unbind ${thread.boundPr.repo}`,
                  run: () => attempt("unbind the PR", api.prUnbind(id)),
                },
              ]
            : []),
          {
            id: `scope:bindPr:${id}`,
            label: thread.boundPr ? "Follow another PR…" : "Bind PR…",
            keywords: "pr pull request bind link follow",
            run: () => open({ kind: "bindPr", threadId: id }),
          },
        ],
      });
    }
    const spawner = thread.spawnedBy?.threadId;
    const entry = ledger?.features
      .flatMap((feature) => feature.workers)
      .find((each) => each.threadId === id);
    const held = entry?.userIntervened;
    const takeable =
      entry !== undefined &&
      !entry.userIntervened &&
      entry.state !== "merged" &&
      entry.state !== "delivered" &&
      entry.state !== "archived";
    const joinable = actions.joinTargets.length > 0;
    const workerItems: PaletteItem[] = [
      ...(spawner !== undefined && byId[spawner] !== undefined
        ? [
            {
              id: `scope:orchestrator:${id}`,
              label: "Go to orchestrator",
              run: () => goTo(spawner),
            },
          ]
        : []),
      ...(workerWorkspace === undefined ? [] : [board(workerWorkspace.workspace.id)]),
      ...(held === true
        ? [{ id: `scope:release:${id}`, label: "Hand back to orchestrator", run: actions.release }]
        : []),
      ...(takeable
        ? [{ id: `scope:takeOver:${id}`, label: "Take over", run: actions.takeOver }]
        : []),
      ...(thread.checkout.kind === "worktree" && mergedPrRef(summary) !== undefined
        ? [
            {
              id: `scope:cleanup:${id}`,
              label: "Clean up worktree…",
              run: () =>
                open({
                  kind: "close",
                  threadId: id,
                  preset: {
                    removeWorktree: true,
                    deleteBranch: branchDeleteLooksSafe(summary?.git),
                  },
                }),
            },
          ]
        : []),
      ...(joinable
        ? [
            {
              id: `scope:join:${id}`,
              label: thread.spawnedBy ? "Move to workspace…" : "Add to workspace…",
              keywords: "worker orchestrator join",
              ...(thread.checkout.kind === "worktree" ? {} : { unavailable: JOIN_NEEDS_WORKTREE }),
              run: () => {},
              opens: () => ({
                title: thread.spawnedBy ? "Move to workspace" : "Add to workspace",
                items: actions.joinTargets.map((target) => ({
                  id: `join:${target.workspaceId}`,
                  label: target.name,
                  ...(target.adds.length > 0
                    ? {
                        hint:
                          target.adds.length === 1
                            ? `adds ${target.adds[0]}`
                            : `adds ${target.adds.length} repos`,
                      }
                    : {}),
                  run: () => actions.join(target.workspaceId, target.adds.length > 0),
                })),
              }),
            },
          ]
        : []),
      ...(thread.spawnedBy
        ? [{ id: `scope:detach:${id}`, label: "Remove from workspace", run: actions.detach }]
        : []),
    ];
    if (workerItems.length > 0) {
      threadSections.push({ id: "workspace", label: "Workspace", items: workerItems });
    }
  }

  const workspaceSections: PaletteSection[] = [];
  if (scopedWorkspace !== undefined) {
    const { workspace, paused } = scopedWorkspace;
    const workspaceId = workspace.id;
    const tidyOrchestrator = threadId;
    const projectsById = new Map(projects.map((project) => [project.id as string, project]));
    const removable = removableRepos(workspace);
    workspaceSections.push({
      id: "workspace",
      label: "Workspace",
      items: [
        ...(threadId === undefined
          ? [
              {
                id: `scope:openOrchestrator:${workspaceId}`,
                label: "Open orchestrator",
                run: () =>
                  void api.openOrchestrator({ workspaceId }).then(
                    (opened) => goTo(opened.id),
                    (error: unknown) =>
                      fail(`Couldn't open the orchestrator: ${errorMessage(error)}`),
                  ),
              },
            ]
          : []),
        board(workspaceId),
        {
          id: `scope:memory:${workspaceId}`,
          label: "Open memory",
          keywords: "orchestrator dream import questions decisions files",
          run: () => void navigate({ to: "/w/$workspaceId/memory", params: { workspaceId } }),
        },
        {
          id: `scope:files:${workspaceId}`,
          label: "Open files",
          keywords: "screenshots recordings images documents evidence outputs",
          run: () => void navigate({ to: "/w/$workspaceId/files", params: { workspaceId } }),
        },
        {
          id: `scope:settings:${workspaceId}`,
          label: "Workspace settings",
          keywords: "autonomy repos charter models",
          run: () => openWorkspaceSettings(workspaceId),
        },
        {
          id: `scope:pause:${workspaceId}`,
          label: paused === undefined ? "Pause workspace" : "Resume workspace",
          keywords: "orchestration stop waking spawning",
          run: () =>
            attempt(
              paused === undefined ? "pause the workspace" : "resume the workspace",
              setWorkspacePaused(api, queryClient, workspace, paused === undefined),
            ),
        },
        ...(tidyOrchestrator !== undefined && tidyUpBlocked(byId[tidyOrchestrator]) === undefined
          ? [
              {
                id: `scope:tidyUp:${workspaceId}`,
                label: "Tidy up workspace",
                keywords: "clean up organise organize housekeeping archive stages groups",
                run: () =>
                  attempt(
                    "ask the orchestrator to tidy up",
                    sendTidyUp(api, tidyOrchestrator).then((queued) =>
                      useThreadsStore.getState().applyEvent({
                        type: "notify",
                        kind: "info",
                        title: "Asked the orchestrator to tidy up",
                        body: queued
                          ? "It starts once its current turn ends."
                          : "It summarises what it changed when it is done.",
                      }),
                    ),
                  ),
              },
            ]
          : []),
        {
          id: `scope:addRepo:${workspaceId}`,
          label: "Add repository…",
          keywords: "clone git github repo project folder",
          run: () => open({ kind: "addRepo", workspaceId }),
        },
        ...(removable.length > 0
          ? [
              {
                id: `scope:removeRepo:${workspaceId}`,
                label: "Remove repository…",
                keywords: "repo project folder workspace",
                run: () => {},
                opens: () => ({
                  title: "Remove repository",
                  items: removable.map((projectId) => ({
                    id: `repo:${projectId}`,
                    label: projectsById.get(projectId)?.name ?? projectId,
                    run: () =>
                      removeWorkspaceRepo(
                        api,
                        queryClient,
                        workspace,
                        projectId,
                        projectsById.get(projectId),
                      ),
                  })),
                }),
              },
            ]
          : []),
        {
          id: `scope:newLike:${workspaceId}`,
          label: "New workspace like this…",
          keywords: "copy duplicate clone workspace setup charter roster",
          run: () => void navigate({ to: "/new-workspace", search: { from: workspaceId } }),
        },
        {
          id: `scope:removeWorkspace:${workspaceId}`,
          label: "Remove workspace…",
          keywords: "delete workspace orchestrator close",
          run: () => open({ kind: "removeWorkspace", workspaceId }),
        },
      ],
    });
  }

  return {
    title:
      scope === undefined
        ? undefined
        : scope.kind === "workspace"
          ? scopedWorkspace?.workspace.name
          : thread?.title,
    sections: [...workspaceSections, ...threadSections],
  };
}
