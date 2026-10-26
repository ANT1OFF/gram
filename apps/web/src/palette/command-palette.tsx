import { Dialog } from "@base-ui/react/dialog";
import {
  helperOn,
  waitIsKept,
  type ThreadId,
  type ThreadSearchHit,
  type ThreadSummary,
  type WaitItem,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage, isNotImplemented } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { boardWorkspaceFor } from "@/orchestration/board-model";
import { openFeatureSheet } from "@/orchestration/feature-sheet-store";
import { hiddenIds, useAskStackStore } from "@/orchestration/ask-stack-store";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { threadStatusOf } from "@/sidebar/status";
import { agentLabel } from "@/agents/agent-display";
import { openInNewWindow } from "@/desktop/open-in-new-window";
import { focusOtherWindow } from "@/desktop/open-thread";
import { prefillDraftProject, prefillTaskTarget } from "@/composer/draft-prefill";
import { useStashMenuStore } from "@/composer/stash-store";
import { shortcutHint } from "@/keyboard/bindings";
import { listIndexForKey } from "@/lib/list-keys";
import { formatRelative } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";
import {
  latestSession,
  resumeSession,
  sessionsQueryKey,
  useResumableSessions,
  useResumeModel,
  type ResumableSessions,
} from "@/resume/resume-sessions";
import { useServerSettings } from "@/settings-sync/store";
import { projectNameOf } from "@/settings/workspace-settings-model";
import {
  fitShell,
  GRID_PRESETS,
  PRESET_LABELS,
  splitCandidate,
  useLayoutStore,
  type PaletteScope,
} from "@/stores/layout";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";
import { recentlyResolved } from "@/thread/waiting-model";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useThreadSearch, type ThreadSearchState } from "@/thread/use-thread-search";
import { threadDisplayTitle } from "@/thread/thread-title";
import { toggleOverviewSidebar } from "@/views/shell-layout";

import { useReportIssueDialog } from "@/report-issue/report-issue-dialog";
import { stepNeedsYou } from "@/orchestration/use-needs-you";

import {
  buildScopedSections,
  buildSections,
  flattenSections,
  matchItems,
  type PaletteItem,
  type PalettePicker,
  type PaletteSection,
  threadScope,
} from "./palette-items";
import { useScopeCommands, type ScopeSteps } from "./scope-commands";
import { matchesWordFilters } from "./word-filters";
import { useWordFilters, WordFilterControls } from "./word-filter-controls";
import { Snippet } from "./snippet";

/** Steps of "Open in pane…" that keep the palette open for the next pick. */
const KEEPS_OPEN = /^(pick:|action:openInPane$|action:resume$)/;
const MESSAGE_LIMIT = 20;
/** Claude Code on the web, opened as a plain page: Gram reads no session list from it. */
const CLAUDE_CODE_WEB = "https://claude.ai/code";

/** Reports an action that failed after the palette closed. */
const notifyError = (title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind: "error", title, body });

/** A command's key, when it has one bound. */
const shortcut = (id: string) => {
  const keys = shortcutHint(id);
  return keys === "" ? {} : { shortcut: keys };
};

const nonEmpty = (section: PaletteSection) => section.items.length > 0;

const scopeKey = (scope: PaletteScope | undefined) =>
  scope === undefined
    ? "all"
    : scope.kind === "thread"
      ? `thread:${scope.threadId}`
      : `workspace:${scope.workspaceId}`;

/** `⌘K`: go to threads, workers, features and PRs; `>` for commands; More… opens it scoped. */
export function CommandPalette() {
  const open = useLayoutStore((s) => s.paletteOpen);
  const initialQuery = useLayoutStore((s) => s.paletteQuery);
  const initialScope = useLayoutStore((s) => s.paletteScope);
  const closePalette = useLayoutStore((s) => s.closePalette);
  // Opened from a shortcut or the store, with no trigger to return to.
  const opener = useOpener(open);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="command-palette"
          data-surface="overlay"
          aria-label="Command palette"
          finalFocus={() => {
            // A palette action can open a thread dialog before this popup's exit ends. Returning
            // focus to the opener then steals that dialog's first keystroke (real e2e clone flow).
            if (useThreadDialogs.getState().dialog !== undefined) return false;
            return returnFocusTo(opener)();
          }}
          className="fixed top-[15%] left-1/2 z-50 flex max-h-[60vh] w-[min(36rem,90vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && (
            <PaletteBody
              initialQuery={initialQuery}
              initialScope={initialScope}
              onDone={closePalette}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody({
  initialQuery,
  initialScope,
  onDone,
}: {
  initialQuery: string;
  initialScope: PaletteScope | undefined;
  onDone: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const currentId = params.threadId as ThreadId | undefined;
  const byId = useThreadsStore((s) => s.byId);
  const askHeld = useAskStackStore((s) => s.held);
  const askSent = useAskStackStore((s) => s.sent);
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const panes = useLayoutStore((s) => s.grid.panes);
  const filterHelpersOn = useServerSettings(
    (s) => s.settings !== undefined && helperOn(s.settings, "suggest"),
  );
  const currentThread = currentId ? byId[currentId]?.thread : undefined;
  const currentProjectId = currentThread?.projectId;
  const workspaces = useWorkspaces();
  /** Whether `projectId` has the one-project workspace `openOrchestrator` would otherwise make. */
  const hasOwnWorkspace = (projectId: string) =>
    workspaces.some(
      ({ workspace }) => workspace.projectIds.length === 1 && workspace.homeProjectId === projectId,
    );
  // On a board or a memory view, the workspace on screen; elsewhere, the current thread's.
  const shownWorkspace = params.workspaceId as WorkspaceId | undefined;
  const boardWorkspace = boardWorkspaceFor(
    currentThread ?? (shownWorkspace === undefined ? undefined : { workspaceId: shownWorkspace }),
    workspaces,
  );
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  /** The thread or workspace whose commands alone are listed: More… opens it, Tab enters one. */
  const [scope, setScope] = useState(initialScope);
  /** A command's second step: a layout, a label, a pane. */
  const [picker, setPicker] = useState<PalettePicker>();
  /** "Open in pane…": first pick a thread, then a pane. */
  const [picking, setPicking] = useState<{ threadId?: ThreadId }>();
  /** "Resume a past session…": the folder whose sessions are listed. */
  const [resumeRoot, setResumeRoot] = useState<string>();
  /** "Reopen Waiting on you item…": the thread whose resolved items are listed. */
  const [reopenIn, setReopenIn] = useState<ThreadId>();
  const stepping =
    picker !== undefined ||
    picking !== undefined ||
    resumeRoot !== undefined ||
    reopenIn !== undefined;
  const searchMode = !stepping && scope === undefined && !query.startsWith(">");
  const input = useRef<HTMLInputElement>(null);
  const namedWorkspaces = workspaces.map(({ workspace }) => ({
    id: workspace.id as string,
    name: workspace.name,
  }));
  const wordFilters = useWordFilters(query, JSON.stringify(namedWorkspaces), searchMode);
  const messageSearch = useThreadSearch(searchMode ? query : "", { limit: MESSAGE_LIMIT });
  const resumeQuery = useResumableSessions(resumeRoot);
  const now = useNow(reopenIn !== undefined, undefined, 60_000);
  const resolvedQuery = useQuery({
    queryKey: ["thread.listWaits", reopenIn, "all"],
    queryFn: () => api.listWaits(reopenIn!, "all"),
    enabled: reopenIn !== undefined,
  });
  const resumeModelFor = useResumeModel();

  const fresh = () => {
    setQuery("");
    setActive(0);
  };
  const restart = (next: { threadId?: ThreadId }) => {
    setPicking(next);
    fresh();
  };
  const enterScope = (next: PaletteScope | undefined) => {
    setScope(next);
    setPicker(undefined);
    setPicking(undefined);
    setResumeRoot(undefined);
    setReopenIn(undefined);
    fresh();
  };
  const steps: ScopeSteps = {
    pickPane: (threadId) => restart({ threadId }),
    reopenWaits: (threadId) => {
      setReopenIn(threadId);
      fresh();
    },
  };
  const scoped = useScopeCommands(scope, steps);
  // The thread and workspace in view, whose commands `>` matches once something is typed.
  const viewThread =
    scope === undefined && currentThread !== undefined && currentThread.role !== "orchestrator"
      ? currentThread
      : undefined;
  const inViewThread = useScopeCommands(
    viewThread === undefined ? undefined : { kind: "thread", threadId: viewThread.id },
    steps,
  );
  const inViewWorkspace = useScopeCommands(
    scope === undefined && boardWorkspace !== undefined
      ? { kind: "workspace", workspaceId: boardWorkspace }
      : undefined,
    steps,
  );

  const workspaceNames = new Map(workspaces.map(({ workspace }) => [workspace.id, workspace.name]));
  const recent = Object.values(byId).toSorted(
    (a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt,
  );
  const filterThreadId = currentId ?? recent[0]?.thread.id;
  const hasWordControls =
    searchMode &&
    (wordFilters.filters.length > 0 ||
      (filterHelpersOn &&
        filterThreadId !== undefined &&
        wordFilters.remainder.trim().split(/\s+/).length >= 3 &&
        query.length <= 500));
  const answered = hiddenIds({ held: askHeld, sent: askSent });
  const describe = (summary: ThreadSummary) => ({
    label: summary.thread.title,
    hint: `${projectNameOf(projects, summary.thread.projectId)} · ${threadStatusOf(summary).label}`,
    keywords: summary.thread.checkout.branch ?? "",
  });
  const goTo = (threadId: ThreadId) => {
    if (focusOtherWindow(threadId)) return;
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
  const threads: PaletteItem[] = recent
    .filter(({ thread }) => thread.spawnedBy === undefined)
    .map((summary) => ({
      id: `thread:${summary.thread.id}`,
      ...describe(summary),
      scope: threadScope(summary.thread),
      run: () => goTo(summary.thread.id),
    }));
  const workers: PaletteItem[] = recent
    .filter(({ thread }) => thread.spawnedBy !== undefined)
    .map((summary) => ({
      id: `worker:${summary.thread.id}`,
      label: summary.thread.title,
      hint: `${summary.thread.spawnedBy?.feature ?? ""} · ${threadStatusOf(summary).label}`,
      keywords: `${summary.thread.checkout.branch ?? ""} ${workspaceNames.get(summary.thread.workspaceId as WorkspaceId) ?? ""}`,
      scope: threadScope(summary.thread),
      run: () => goTo(summary.thread.id),
    }));
  // A feature is the workers spawned for it, in each workspace that is listed.
  const featureWorkers = new Map<
    string,
    { workspaceId: WorkspaceId; feature: string; count: number }
  >();
  for (const { thread } of recent) {
    const feature = thread.spawnedBy?.feature;
    const workspaceId = thread.workspaceId as WorkspaceId | undefined;
    if (feature === undefined || workspaceId === undefined || !workspaceNames.has(workspaceId)) {
      continue;
    }
    const key = `${workspaceId}:${feature}`;
    const seen = featureWorkers.get(key);
    featureWorkers.set(key, { workspaceId, feature, count: (seen?.count ?? 0) + 1 });
  }
  const features: PaletteItem[] = [...featureWorkers].map(
    ([key, { workspaceId, feature, count }]) => ({
      id: `feature:${key}`,
      label: feature,
      hint: `${workspaceNames.get(workspaceId)} · ${count === 1 ? "1 worker" : `${count} workers`}`,
      scope: { kind: "workspace", workspaceId },
      // Its sheet: where it stands, its PRs and workers, and its menu.
      run: () => openFeatureSheet(workspaceId, feature),
    }),
  );
  const prs: PaletteItem[] = recent.flatMap((summary) => {
    const pr = summary.git?.pr;
    if (pr === undefined) return [];
    return [
      {
        id: `pr:${summary.thread.id}`,
        label: `#${pr.number} ${pr.title}`,
        hint: `${projectNameOf(projects, summary.thread.projectId)} · ${summary.thread.title}`,
        keywords: `${pr.url} pull request`,
        scope: threadScope(summary.thread),
        run: () => goTo(summary.thread.id),
      },
    ];
  });

  const openHit = (hit: ThreadSearchHit) => {
    if (focusOtherWindow(hit.threadId)) return;
    if (hit.messageId) useRevealStore.getState().reveal(hit.threadId, hit.messageId);
    useLayoutStore.getState().openThread(hit.threadId);
    void navigate({ to: "/t/$threadId", params: { threadId: hit.threadId } });
  };
  const messageItems: PaletteItem[] =
    messageSearch.status === "done"
      ? messageSearch.hits.map((hit, i) => ({
          id: `message:${hit.threadId}:${hit.messageId ?? i}`,
          label: hit.title,
          snippet: { text: hit.snippet, highlights: hit.highlights },
          run: () => openHit(hit),
        }))
      : [];

  const projectItems: PaletteItem[] = projects.map((project) => ({
    id: `project:${project.id}`,
    label: project.name,
    hint: project.root,
    run: () => {
      prefillDraftProject(project.root);
      void navigate({ to: "/new" });
    },
  }));

  const actions: PaletteItem[] = [
    {
      id: "action:new",
      label: "New task",
      ...shortcut("thread.new"),
      run: () => void navigate({ to: "/new-task" }),
    },
    {
      id: "action:oneOff",
      label: "New one-off thread",
      ...shortcut("thread.newInProject"),
      keywords: "new thread plain",
      run: () => {
        const checkout = currentThread?.checkout;
        prefillDraftProject(checkout ? (checkout.repoRoot ?? checkout.path) : undefined);
        void navigate({ to: "/new" });
      },
    },
    {
      id: "action:newWorkspace",
      label: "New workspace…",
      keywords: "create workspace orchestrator setup wizard repos roster copy",
      run: () => void navigate({ to: "/new-workspace" }),
    },
    ...(viewThread === undefined
      ? []
      : [
          {
            id: "action:scopeThread",
            label: "This thread…",
            keywords: "thread commands rename pin park label fork restart close more",
            stay: true,
            run: () => enterScope({ kind: "thread", threadId: viewThread.id }),
          },
        ]),
    ...(boardWorkspace === undefined
      ? []
      : [
          {
            id: "action:scopeWorkspace",
            label: "This workspace…",
            keywords: "workspace commands board memory settings pause repos more",
            stay: true,
            run: () => enterScope({ kind: "workspace", workspaceId: boardWorkspace }),
          },
          {
            id: "action:workspaceFiles",
            label: "Workspace files",
            keywords: "screenshots recordings images documents evidence outputs",
            run: () =>
              void navigate({
                to: "/w/$workspaceId/files",
                params: { workspaceId: boardWorkspace },
              }),
          },
        ]),
    ...(currentProjectId !== undefined && !hasOwnWorkspace(currentProjectId)
      ? [
          {
            // Opening one would make the project's workspace at the default autonomy unasked: the
            // New task draft says what that lets it do, and lets the user pick another first.
            id: "action:openOrchestrator",
            label: "Start project workspace…",
            keywords: "orchestrate orchestrator workers workspace dispatch autonomy",
            run: () => {
              prefillTaskTarget({ kind: "repo", projectId: currentProjectId });
              void navigate({ to: "/new-task" });
            },
          },
        ]
      : []),
    ...(currentProjectId !== undefined && hasOwnWorkspace(currentProjectId)
      ? [
          {
            id: "action:openOrchestrator",
            label: "Open project orchestrator",
            keywords: "orchestrate workers workspace dispatch",
            run: () => {
              api
                .openOrchestrator({ projectId: currentProjectId })
                .then((thread) => {
                  useLayoutStore.getState().openThread(thread.id);
                  void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
                })
                .catch((error: unknown) =>
                  notifyError("Couldn't open the orchestrator", errorMessage(error)),
                );
            },
          },
        ]
      : []),
    {
      id: "action:addRepo",
      label: "Add repository…",
      keywords: "clone git github repo project folder",
      run: () => useThreadDialogs.getState().open({ kind: "addRepo" }),
    },
    {
      id: "action:checkoutPr",
      label: "Check out PR…",
      keywords: "pull request review branch",
      run: () => {
        const projectRoot = projects.find((p) => p.id === currentProjectId)?.root;
        useThreadDialogs
          .getState()
          .open(
            projectRoot === undefined
              ? { kind: "checkoutPr" }
              : { kind: "checkoutPr", projectRoot },
          );
      },
    },
    ...(currentId
      ? [
          {
            id: "action:stashes",
            label: "Stashed drafts…",
            ...shortcut("composer.stash"),
            keywords: "stash draft restore",
            run: () => useStashMenuStore.getState().open(currentId),
          },
        ]
      : []),
    {
      id: "action:resume",
      label: "Resume past session…",
      keywords: "claude codex sessions folder history",
      run: () => {
        const root =
          currentThread?.checkout.path ??
          useServerSettings.getState().settings?.agents.defaultFolder;
        if (root) {
          setResumeRoot(root);
          fresh();
        } else {
          onDone();
          void navigate({ to: "/new" });
        }
      },
    },
    {
      id: "action:continue",
      label: "Continue latest session",
      keywords: "claude --continue newest folder",
      run: () => {
        const settings = useServerSettings.getState().settings;
        const thread = currentThread;
        const root = thread?.checkout.path ?? settings?.agents.defaultFolder;
        if (!root) {
          void navigate({ to: "/new" });
          return;
        }
        const agent = thread?.model.agent ?? settings?.agents.defaultModel?.agent ?? "claude";
        latestSession(api, agent, root)
          .then(async (session) => {
            if (session === undefined) {
              notifyError(
                "Nothing to continue",
                `No past ${agentLabel(agent)} sessions in ${root}.`,
              );
              return;
            }
            const threadId = await resumeSession(api, session, root, resumeModelFor(agent));
            void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(root) });
            useLayoutStore.getState().openThread(threadId as ThreadId);
            void navigate({ to: "/t/$threadId", params: { threadId } });
          })
          .catch((error: unknown) =>
            notifyError("Couldn't continue the session", errorMessage(error)),
          );
      },
    },
    {
      id: "action:nextNeedsYou",
      label: "Next that needs you",
      ...shortcut("thread.nextNeedsYou"),
      run: () => stepNeedsYou(1),
    },
    {
      id: "action:split",
      label: "Split / unsplit",
      ...shortcut("split.toggle"),
      run: () => {
        if (!currentId) return;
        const { grid, toggleSplit } = useLayoutStore.getState();
        const summaries = Object.values(useThreadsStore.getState().byId);
        toggleSplit(grid.preset === "1" ? splitCandidate(summaries, grid.panes) : undefined);
      },
    },
    {
      id: "action:layout",
      label: "Layout…",
      keywords: GRID_PRESETS.map((preset) => PRESET_LABELS[preset]).join(" ") + " grid panes",
      run: () => {},
      opens: () => ({
        title: "Layout",
        items: GRID_PRESETS.map((preset) => ({
          id: `layout:${preset}`,
          label: PRESET_LABELS[preset],
          ...(useLayoutStore.getState().grid.preset === preset ? { hint: "Current" } : {}),
          run: () => useLayoutStore.getState().setPreset(preset),
        })),
      }),
    },
    {
      id: "action:openInPane",
      label: "Open in pane…",
      run: () => restart({}),
    },
    {
      id: "action:newWindow",
      label: "New window",
      ...shortcut("window.new"),
      run: () => void openInNewWindow(),
    },
    {
      id: "action:maximize",
      label: "Maximize / restore pane",
      ...shortcut("pane.maximize"),
      run: () => useLayoutStore.getState().toggleMaximize(),
    },
    {
      id: "action:sidebar",
      label: "Collapse / expand sidebar",
      ...shortcut("sidebar.toggle"),
      run: toggleOverviewSidebar,
    },
    {
      id: "action:panel",
      label: "Show / hide right panel",
      ...shortcut("panel.toggle"),
      run: () => useLayoutStore.getState().togglePanel(),
    },
    {
      id: "action:panelExpand",
      label: "Expand / restore right panel",
      run: () => {
        const layout = useLayoutStore.getState();
        const { panelExpanded, togglePanel, setPanelExpanded } = layout;
        if (!panelExpanded && fitShell(layout).panel === "none") togglePanel();
        setPanelExpanded(!panelExpanded);
      },
    },
    {
      id: "action:focus",
      label: "Focus mode",
      ...shortcut("focus.toggle"),
      run: () => useLayoutStore.getState().toggleFocusMode(),
    },
    {
      id: "action:closeAll",
      label: "Close all threads…",
      run: () => useThreadDialogs.getState().open({ kind: "closeAll" }),
    },
    {
      id: "action:labels",
      label: "Edit labels…",
      run: () => useThreadDialogs.getState().open({ kind: "labels" }),
    },
    {
      id: "action:shortcuts",
      label: "Keyboard shortcuts",
      ...shortcut("overlay.shortcuts"),
      run: () => useLayoutStore.getState().setOverlayOpen(true),
    },
    {
      id: "action:claudeCode",
      label: "Open claude.ai/code",
      keywords: "claude cloud web sessions browser",
      run: () =>
        void openExternalUrl(api, CLAUDE_CODE_WEB).catch((error: unknown) =>
          notifyError("Couldn't open claude.ai/code", errorMessage(error)),
        ),
    },
    {
      id: "action:reportIssue",
      label: "Report an issue…",
      keywords: "bug feedback feature request github question",
      run: () => useReportIssueDialog.getState().show(currentId),
    },
    {
      id: "action:settings",
      label: "Settings",
      ...shortcut("settings.open"),
      run: () => void navigate({ to: "/settings" }),
    },
  ];
  // The workspace's own verbs, and its orchestrator's thread verbs only on the orchestrator itself;
  // the same command can come from the thread and from its workspace, so it is listed once.
  const inView = [
    ...flattenSections(
      viewThread === undefined
        ? inViewWorkspace.sections
        : inViewWorkspace.sections.filter((section) => section.id === "workspace"),
    ),
    ...flattenSections(inViewThread.sections),
  ].filter(
    (item, index, all) =>
      all.findIndex((other) => other.id === item.id) === index &&
      // A command the app has anyway, such as Open in pane…, is listed once, with the others.
      !actions.some((action) => action.label === item.label),
  );

  const pickedId = picking?.threadId;
  const pickThreads: PaletteItem[] = recent.map((summary) => ({
    id: `pick:${summary.thread.id}`,
    ...describe(summary),
    run: () => restart({ threadId: summary.thread.id }),
  }));
  const paneItems: PaletteItem[] = pickedId
    ? panes.map((occupant, index) => ({
        id: `pane:${index}`,
        label: `Pane ${index + 1}`,
        hint: occupant ? threadDisplayTitle(byId[occupant]?.thread) : "Empty",
        run: () => {
          if (focusOtherWindow(pickedId)) return;
          useLayoutStore.getState().openInPane(pickedId, index);
          void navigate({ to: "/t/$threadId", params: { threadId: pickedId } });
        },
      }))
    : [];

  const pickSection: PaletteSection =
    pickedId === undefined
      ? {
          id: "threads",
          label: "Open in pane: pick a thread",
          items: matchItems(pickThreads, query),
        }
      : {
          id: "actions",
          label: `Open “${threadDisplayTitle(byId[pickedId]?.thread)}” in pane`,
          items: matchItems(paneItems, query),
        };
  const resumeItems: PaletteItem[] = (resumeQuery.data?.sessions ?? []).map((session) => ({
    id: `resume:${session.agent}:${session.agentSessionId}`,
    label: session.title,
    hint: [
      agentLabel(session.agent),
      formatRelative(session.updatedAt),
      session.gitBranch,
      session.threadId ? "open" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    keywords: [agentLabel(session.agent), session.firstPrompt ?? ""].join(" "),
    run: () => {
      if (resumeRoot === undefined) return;
      resumeSession(api, session, resumeRoot, resumeModelFor(session.agent)).then(
        (threadId) => {
          void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(resumeRoot) });
          useLayoutStore.getState().openThread(threadId as ThreadId);
          void navigate({ to: "/t/$threadId", params: { threadId } });
        },
        (error: unknown) =>
          useThreadsStore.getState().applyEvent({
            type: "notify",
            kind: "error",
            title: "Couldn't resume the session",
            body: errorMessage(error),
          }),
      );
    },
  }));
  const resumeSection: PaletteSection = {
    id: "threads",
    label: `Resume in ${resumeRoot?.split(/[\\/]/).filter(Boolean).at(-1) ?? "folder"}`,
    items: matchItems(resumeItems, query),
  };

  const reopenItems: PaletteItem[] =
    reopenIn === undefined
      ? []
      : recentlyResolved(resolvedQuery.data ?? [], now).map((item) => ({
          id: `reopen:${item.id}`,
          label: item.title,
          hint: `Done ${formatRelative(item.resolvedAt!)}${item.resolvedBy === "agent" ? " by the agent" : ""}`,
          run: () =>
            void api
              .resolveWait(reopenIn, item.id, true)
              .catch((error: unknown) => notifyError("Couldn't reopen it", errorMessage(error))),
        }));
  const reopenSection: PaletteSection = {
    id: "actions",
    label: "Reopen in Waiting on you",
    items: matchItems(reopenItems, query),
  };

  const sections: PaletteSection[] =
    picker !== undefined
      ? [
          { id: "pick" as const, label: picker.title, items: matchItems(picker.items, query) },
        ].filter(nonEmpty)
      : resumeRoot !== undefined
        ? [resumeSection].filter(nonEmpty)
        : reopenIn !== undefined
          ? [reopenSection].filter(nonEmpty)
          : picking
            ? [pickSection].filter(nonEmpty)
            : scope !== undefined
              ? buildScopedSections(query, scoped.sections)
              : [
                  ...buildSections(query, {
                    threads,
                    workers,
                    features,
                    prs,
                    projects: projectItems,
                    actions,
                    scoped: inView,
                  }),
                  ...(messageItems.length > 0
                    ? [{ id: "messages" as const, label: "Messages", items: messageItems }]
                    : []),
                ];
  // Plain matches (including messages) always remain first and untouched by parsing or editing.
  if (searchMode && wordFilters.filters.length > 0) {
    const filtered: PaletteItem[] = recent.flatMap((summary) => {
      const kind = summary.thread.spawnedBy === undefined ? "thread" : "worker";
      const candidates: { kind: string; item: PaletteItem; at?: number }[] = [
        {
          kind,
          item: [...threads, ...workers].find(
            (item) => item.id === `${kind}:${summary.thread.id}`,
          )!,
        },
        ...prs
          .filter((item) => item.id === `pr:${summary.thread.id}`)
          .map((item) => ({ kind: "pr", item })),
        ...(summary.waits ?? []).filter(waitIsKept).map((wait) => ({
          kind: "ask",
          at: wait.updatedAt ?? wait.createdAt,
          item: {
            id: `ask:${wait.id}`,
            label: wait.title,
            hint: summary.thread.title,
            run: () => goTo(summary.thread.id),
          },
        })),
        // Only what the stack still asks: one answered, or held to be sent, is gone from it.
        ...summary.pendingRequests
          .filter((request) => !answered.has(request.id))
          .map((request) => ({
            kind: "ask",
            item: {
              id: `ask:${request.id}`,
              label:
                request.kind === "question"
                  ? (request.questions[0]?.question ?? "Question")
                  : "Approval needed",
              hint: summary.thread.title,
              run: () => goTo(summary.thread.id),
            },
          })),
      ];
      return candidates
        .filter((candidate) =>
          matchesWordFilters(
            summary,
            candidate.kind,
            wordFilters.filters,
            Date.now(),
            candidate.at,
          ),
        )
        .map(({ item }) => ({ ...item, id: `filtered:${item.id}` }));
    });
    sections.push({
      id: "filtered",
      label: "Filtered results",
      items: matchItems(filtered, wordFilters.text).slice(0, 30),
    });
  }
  const items = flattenSections(sections);
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);
  const activeItem = activeIndex === -1 ? undefined : items[activeIndex];

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    // The palette stays, with the reason, so another command can be picked.
    if (item.unavailable !== undefined) {
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "info",
        title: `${item.label.replace(/…$/, "")} isn't available`,
        body: item.unavailable,
      });
      return;
    }
    if (item.opens) {
      setPicker(item.opens());
      fresh();
      return;
    }
    if (!item.stay && !KEEPS_OPEN.test(item.id)) onDone();
    item.run();
  };
  /** One step back: out of a second step, then out of the scope. */
  const back = () => {
    if (picker !== undefined) setPicker(undefined);
    else if (stepping) {
      setPicking(undefined);
      setResumeRoot(undefined);
      setReopenIn(undefined);
    } else if (scope !== undefined) setScope(undefined);
    else return false;
    fresh();
    return true;
  };

  // Focus stays in the search field, so the browser won't scroll the active item into view itself.
  useEffect(() => {
    if (activeIndex === -1) return;
    document.getElementById(`palette-item-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (
      searchMode &&
      (event.key === "Home" ||
        event.key === "End" ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey)
    )
      return;
    if (event.key === "Backspace" && query === "" && back()) {
      event.preventDefault();
      return;
    }
    if (items.length === 0) return;
    const next = listIndexForKey(event.key, activeIndex, items.length);
    if (next !== undefined) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(activeItem);
    } else if (
      event.key === "Tab" &&
      !event.shiftKey &&
      !hasWordControls &&
      activeItem?.scope !== undefined
    ) {
      event.preventDefault();
      enterScope(activeItem.scope);
    }
  };

  const scopeTitle = scope === undefined ? undefined : (scoped.title ?? "…");
  let index = -1;
  return (
    <>
      <Dialog.Title className="sr-only">Command palette</Dialog.Title>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {scopeTitle !== undefined && (
          <span
            data-testid="palette-scope"
            className="flex max-w-48 shrink-0 items-center gap-1 rounded-sm bg-accent py-0.5 pr-0.5 pl-1.5 text-xs text-accent-foreground"
          >
            <span className="truncate">{scopeTitle}</span>
            <button
              type="button"
              aria-label="All commands"
              title="All commands (⌫)"
              onClick={() => enterScope(undefined)}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        )}
        <input
          autoFocus
          ref={input}
          aria-label={
            scope === undefined ? "Go to, or > for commands" : `Commands for ${scopeTitle}`
          }
          role="combobox"
          aria-expanded
          aria-controls="palette-results"
          aria-activedescendant={activeIndex === -1 ? undefined : `palette-item-${activeIndex}`}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:shadow-[inset_0_-2px_0_0_var(--focus-ring)]"
          placeholder={
            scope === undefined
              ? "Go to a thread, worker or PR… (> for commands)"
              : scope.kind === "thread"
                ? "Thread commands…"
                : "Workspace commands…"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {searchMode && (
        <WordFilterControls
          query={query}
          text={wordFilters.remainder}
          filters={wordFilters.filters}
          workspaces={namedWorkspaces}
          threadId={filterThreadId}
          setFilters={wordFilters.setFilters}
          input={input}
        />
      )}
      {/* A new scope or step swaps the list in where the old one stood. */}
      <Swap
        as="div"
        swapKey={`${scopeKey(scope)}:${picker?.title ?? ""}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div id="palette-results" role="listbox" className="min-h-0 overflow-y-auto p-1">
          {sections.length === 0 && (!searchMode || messageSearch.status !== "searching") && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</p>
          )}
          {sections.map((section) => (
            <div key={section.id} role="group" aria-label={section.label} className="mb-1">
              <div className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {section.label}
              </div>
              {section.id === "filtered" && section.items.length === 0 && (
                <p className="px-2 py-2 text-sm text-muted-foreground">No filtered matches</p>
              )}
              {section.items.map((item) => {
                index++;
                const itemIndex = index;
                return (
                  <div
                    key={item.id}
                    id={`palette-item-${itemIndex}`}
                    role="option"
                    aria-selected={itemIndex === activeIndex}
                    aria-disabled={item.unavailable !== undefined || undefined}
                    title={item.unavailable}
                    onMouseMove={() => setActive(itemIndex)}
                    onClick={() => run(item)}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                      itemIndex === activeIndex &&
                        "bg-accent text-accent-foreground ring-1 ring-ring ring-inset",
                      item.unavailable !== undefined && "text-muted-foreground",
                    )}
                  >
                    {item.snippet ? (
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.label}</span>
                        <Snippet text={item.snippet.text} highlights={item.snippet.highlights} />
                      </span>
                    ) : (
                      <span className="truncate">{item.label}</span>
                    )}
                    {item.hint && (
                      <span
                        data-palette-hint
                        className="ml-auto shrink-0 truncate text-xs text-muted-foreground"
                      >
                        {item.hint}
                      </span>
                    )}
                    {item.shortcut && (
                      <kbd className="ml-auto shrink-0 pl-3 font-mono text-[10px] text-muted-foreground">
                        {item.shortcut}
                      </kbd>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {searchMode && <MessageSearchNote search={messageSearch} />}
          {resumeRoot !== undefined && (
            <ResumeNote query={resumeQuery} empty={resumeItems.length === 0} />
          )}
          {reopenIn !== undefined && (
            <ReopenNote query={resolvedQuery} empty={reopenItems.length === 0} />
          )}
        </div>
      </Swap>
      <div
        data-testid="palette-keys"
        className="flex gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground"
      >
        <span>
          <kbd className="font-mono">⏎</kbd> open
        </span>
        {activeItem?.scope !== undefined && !hasWordControls && (
          <span>
            <kbd className="font-mono">⇥</kbd> its commands
          </span>
        )}
        {hasWordControls && (
          <span>
            <kbd className="font-mono">⇥</kbd> filters
          </span>
        )}
        {scope !== undefined || stepping ? (
          <span>
            <kbd className="font-mono">⌫</kbd> back
          </span>
        ) : (
          !query.startsWith(">") && (
            <span>
              <kbd className="font-mono">&gt;</kbd> commands
            </span>
          )
        )}
      </div>
    </>
  );
}

/** Why "Reopen Waiting on you item…" lists nothing, or that it is still looking. */
function ReopenNote({
  query,
  empty,
}: {
  query: UseQueryResult<readonly WaitItem[]>;
  empty: boolean;
}) {
  const note = query.isPending
    ? "Looking for resolved items…"
    : query.isError
      ? `Couldn't list them: ${errorMessage(query.error)}`
      : empty
        ? "Nothing in this thread's Waiting on you was resolved in the last day."
        : undefined;
  if (!note) return null;
  return (
    <p role="status" data-testid="reopen-note" className="px-3 py-2 text-xs text-muted-foreground">
      {note}
    </p>
  );
}

function ResumeNote({
  query,
  empty,
}: {
  query: UseQueryResult<ResumableSessions>;
  empty: boolean;
}) {
  const note = query.isPending
    ? "Looking for past sessions…"
    : query.isError
      ? isNotImplemented(query.error)
        ? "Listing past sessions isn't available yet."
        : `Couldn't list past sessions: ${errorMessage(query.error)}`
      : !query.data.supported && query.data.failures.length === 0
        ? "No agent here can list its past sessions."
        : empty
          ? "No past sessions in this folder."
          : undefined;
  if (!note) return null;
  return (
    <p role="status" data-testid="resume-note" className="px-3 py-2 text-xs text-muted-foreground">
      {note}
    </p>
  );
}

function MessageSearchNote({ search }: { search: ThreadSearchState }) {
  const note =
    search.status === "searching"
      ? "Searching messages…"
      : search.status === "unavailable"
        ? "Message search isn't available yet."
        : search.status === "error"
          ? `Message search failed: ${search.message}`
          : search.status === "done" && search.truncated
            ? "More messages match; refine the search to narrow them down."
            : undefined;
  if (!note) return null;
  return (
    <p
      role="status"
      data-testid="message-search-note"
      className="px-3 py-2 text-xs text-muted-foreground"
    >
      {note}
    </p>
  );
}
