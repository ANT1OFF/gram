import type { ThreadId, ThreadSummary, WorkspaceId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import {
  Bell,
  ChevronDown,
  Eye,
  FileDiff,
  FileText,
  Focus,
  FolderTree,
  GitPullRequest,
  Globe,
  Maximize2,
  Minimize2,
  Plug,
  SquareTerminal,
  MessagesSquare,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { lazy, Suspense, useEffect, useRef } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { useNotificationHistory, unreadNotifications } from "@/stores/notifications";
import { PreviewSuggestionNotice } from "@/panels/preview-suggestion";
import { useReviewRequests } from "@/reviews/review-requests";
import { useFeature } from "@/settings/use-diagnostics";
import { useToastDock } from "@/shell/toast-dock";
import {
  fitShell,
  isReviewTab,
  reviewsTabShown,
  useLayoutStore,
  type RightPanelTab,
} from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { besideShown, useBesideStore } from "@/orchestration/beside-store";

import { foldedTabs, tabNamed, useTabLabelFit } from "./panel-tab-labels";
import { useKeepReadingPlace } from "./review-room";
import type * as PanelTabs from "./right-panel-tabs";

/** A tab of the strip: the stored ones, and the worker open beside the chat, kept per window. */
type ShownTab = RightPanelTab | "thread";

interface PanelTab {
  value: ShownTab;
  label: string;
  icon: LucideIcon;
  primary?: true;
}

/**
 * The tabs in strip order. Short of room the rest fold into More first, then the primary ones from
 * the strip's end, so the tabs left in the strip keep their names (`panel-tab-labels.ts`).
 */
const TABS: PanelTab[] = [
  // A workspace's workers by where they stand: only beside a thread of a workspace.
  { value: "workers", label: "Workers", icon: Workflow, primary: true },
  { value: "diff", label: "Diff", icon: FileDiff, primary: true },
  { value: "pr", label: "PR", icon: GitPullRequest, primary: true },
  { value: "files", label: "Files", icon: FolderTree, primary: true },
  { value: "terminal", label: "Terminal", icon: SquareTerminal, primary: true },
  { value: "preview", label: "Preview", icon: Globe },
  { value: "docs", label: "Docs", icon: FileText },
  { value: "connectors", label: "Connectors", icon: Plug },
  { value: "reviews", label: "Reviews", icon: Eye },
  { value: "notifications", label: "Notifications", icon: Bell },
];

/** First while a worker is open beside the chat (`beside-store`), and only then. */
const THREAD_TAB: PanelTab = {
  value: "thread",
  label: "Thread",
  icon: MessagesSquare,
  primary: true,
};

let tabsLoad: Promise<typeof PanelTabs> | undefined;

/**
 * The tabs' contents, and the markdown their PR and review comments are shown in: loaded after the
 * shell's first paint, so an open panel's tab appears once, already rendered.
 */
export const preloadRightPanel = () => {
  tabsLoad ??= Promise.all([import("./right-panel-tabs"), loadMarkdown().catch(() => {})]).then(
    ([tabs]) => tabs,
    (error: unknown) => {
      tabsLoad = undefined;
      throw error;
    },
  );
  return tabsLoad;
};

const RightPanelTabs = lazy(() =>
  preloadRightPanel().then((tabs) => ({ default: tabs.RightPanelTabs })),
);

/**
 * Applies an agent's `ui.showPanel` for the viewed thread. Called from the shell rather than the
 * panel, which isn't mounted while hidden.
 */
export function useShowPanelRequests() {
  const params = useParams({ strict: false });
  const threadId = params.threadId as ThreadId | undefined;
  const requestPanel = useLayoutStore((s) => s.requestPanel);
  const previewPane = useFeature("previewPane");

  useEffect(
    () =>
      useThreadsStore.subscribe((s, prev) => {
        if (s.showPanel && s.showPanel !== prev.showPanel) {
          requestPanel(s.showPanel, threadId, { previewPane });
        }
      }),
    [threadId, requestPanel, previewPane],
  );
}

export function RightPanel() {
  const storedTab = useLayoutStore((s) => s.panelTab);
  const reviewsHere = useLayoutStore(reviewsTabShown);
  const requestsHere = useLayoutStore((s) => s.reviewRequestsPlacement === "panel");
  const openPrsHere = useLayoutStore((s) => s.openPrsPlacement === "panel");
  const previewHere = useFeature("previewPane");
  const workspaceId = useRouteWorkspace();
  const workersHere = workspaceId !== undefined;
  // Only review requests count as waiting: the user's own open PRs wait on others.
  const notificationCount = useNotificationHistory(unreadNotifications);
  const reviewCount = useReviewRequests().data?.requests.length ?? 0;
  // The tab is synced between machines and the list's placement is not, so the stored tab can name
  // a Reviews tab this window doesn't have, or a Preview tab where the shell has no preview. Needs
  // you was a tab before the Inbox took its place.
  const panelTab =
    (storedTab === "reviews" && !reviewsHere) ||
    (storedTab === "preview" && !previewHere) ||
    (storedTab === "workers" && !workersHere) ||
    storedTab === "needsYou"
      ? "diff"
      : storedTab;
  // A worker open beside the chat has the Thread tab, picked over the stored one while it shows.
  const besideWorker = useBesideStore((s) => (s.restored ? undefined : s.worker));
  const besideOn = useBesideStore((s) => besideShown(s) !== undefined);
  const setBesideShown = useBesideStore((s) => s.setShown);
  const tab: ShownTab = besideOn ? "thread" : panelTab;
  const setPanelTab = useLayoutStore((s) => s.setPanelTab);
  const setTab = (value: ShownTab) => {
    setBesideShown(value === "thread");
    if (value !== "thread") setPanelTab(value);
  };
  const tabList = useRef<HTMLDivElement>(null);
  const shownTabs = [...(besideWorker === undefined ? [] : [THREAD_TAB]), ...TABS].filter(
    (t) =>
      (t.value !== "reviews" || reviewsHere) &&
      (t.value !== "preview" || previewHere) &&
      (t.value !== "workers" || workersHere),
  );
  const expanded = useLayoutStore((s) => s.panelExpanded);
  const focused = useLayoutStore((s) => s.reviewFocus);
  // On a review the action beside the tabs is Focus review, in words; elsewhere an icon at the end.
  const reviewAction = tab !== "thread" && isReviewTab(tab) && !expanded;
  const labelFit = useTabLabelFit(tabList, tab);
  const aside = useRef<HTMLElement>(null);
  useKeepReadingPlace(aside);
  useEffect(() => {
    // The bell may select a tab beyond the narrow strip's edge without focusing that tab.
    tabList.current
      ?.querySelector<HTMLElement>(`[data-panel-tab="${tab}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const params = useParams({ strict: false });
  const routeThreadId = params.threadId as ThreadId | undefined;
  // A thread the server no longer has, such as a worker closed with its worktree and shown
  // read-only, has no diff, files or terminal to show, so the panels say there is no thread.
  const known = useThreadsStore(
    (s) => routeThreadId !== undefined && (!s.ready || s.byId[routeThreadId] !== undefined),
  );
  const threadId = known ? routeThreadId : undefined;
  const setToastDock = useToastDock((s) => s.setNode);
  const busyTerminals = useThreadsStore((s) =>
    threadId === undefined ? "" : terminalsBusyText(s.byId[threadId]?.terminalProcesses),
  );
  const faces = shownTabs.map((t): TabFaceProps => {
    const count =
      t.value === "notifications"
        ? notificationCount
        : t.value === "reviews" && requestsHere
          ? reviewCount
          : 0;
    const busy = t.value === "terminal" && busyTerminals !== "";
    // The tooltip and the accessible name say the same.
    const name =
      count > 0
        ? `${t.label}, ${count} ${t.value === "notifications" ? "unread" : "waiting"}`
        : busy
          ? `${t.label}: ${busyTerminals}`
          : t.label;
    return { tab: t, count, busy, name };
  });
  // A tab with something waiting or running stays out of More, so its count or dot does too.
  const foldFlags = foldedTabs(
    faces.map((f) => ({
      primary: f.tab.primary === true,
      active: f.tab.value === tab,
      pinned: f.count > 0 || f.busy,
    })),
    labelFit.folds,
  );
  const folded = faces.filter((_, i) => foldFlags[i]);
  const inStrip = faces.filter((_, i) => !foldFlags[i]);

  return (
    <aside
      ref={aside}
      data-testid="right-panel"
      data-surface="chrome"
      className="flex min-h-0 flex-1 flex-col border-l border-border bg-panel"
    >
      <div className="h-(--titlebar-height) shrink-0 [-webkit-app-region:drag]" />
      <PreviewSuggestionNotice threadId={threadId} />
      <Tabs
        value={tab}
        onValueChange={(value: ShownTab) => setTab(value)}
        className="min-h-0 flex-1"
      >
        <div className="relative flex items-center border-b border-border pr-2">
          <TabsList
            ref={tabList}
            data-label-fit={labelFit.tabs}
            className={cn("min-w-0 overflow-x-auto border-b-0", !reviewAction && "flex-1")}
          >
            {/* An icon and a name each, with the rarer tabs and then Terminal, Files, PR and Diff
                folding into More, named there, as room runs out; only a panel too narrow for the
                open tab's name beside More drops to icons. Each is named on hover in every case. */}
            {inStrip.map((face) => (
              // Above the strip, which has the panel's empty top beside the title bar: below, a
              // tab's name would cover the notice or the toolbar under the tabs.
              <Hint
                key={face.tab.value}
                label={face.name}
                side="top"
                render={
                  <TabsTrigger
                    value={face.tab.value}
                    data-panel-tab={face.tab.value}
                    data-primary={face.tab.primary}
                    aria-label={face.name}
                    // A 28 px tab with its background on hover and focus; the open one is named,
                    // on a background and underlined, not told apart by colour alone.
                    className={cn(
                      TAB_BOX,
                      "relative my-1 hover:bg-muted focus-visible:bg-muted aria-selected:bg-muted after:absolute after:inset-x-1.5 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors after:duration-(--dur-fast) aria-selected:after:bg-primary",
                    )}
                  />
                }
              >
                <TabFace
                  {...face}
                  named={tabNamed(labelFit.tabs, face.tab.value === tab)}
                  testIds
                />
              </Hint>
            ))}
          </TabsList>
          {folded.length > 0 && <MoreTabs faces={folded} onPick={setTab} />}
          {/* Every tab and More as they'd stand, named, out of sight: what the fit is measured on. */}
          <div
            aria-hidden
            inert
            data-tab-measure
            className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max overflow-hidden"
          >
            {faces.map((face) => (
              <span
                key={face.tab.value}
                data-measure-tab={face.tab.value}
                data-primary={face.tab.primary}
                data-pinned={face.count > 0 || face.busy ? "" : undefined}
                className={TAB_BOX}
              >
                <TabFace {...face} named />
              </span>
            ))}
            <span data-measure-more className={MORE_BOX}>
              <MoreFace />
            </span>
          </div>
          {reviewAction ? (
            <ReviewFocusAction focused={focused} words={labelFit.action} />
          ) : (
            <ExpandToggle />
          )}
        </div>
        <Suspense fallback={null}>
          <RightPanelTabs
            threadId={threadId}
            workspaceId={workspaceId}
            besideWorker={besideWorker}
            previewHere={previewHere}
            reviewsHere={reviewsHere}
            requestsHere={requestsHere}
            openPrsHere={openPrsHere}
          />
        </Suspense>
      </Tabs>
      {/* Toasts dock here while the panel is open, below the content instead of over it. */}
      <div ref={setToastDock} data-testid="toast-dock" className="shrink-0" />
    </aside>
  );
}

/** A tab's box, as `TabsTrigger` draws it: the strip's tabs and their measured copies share it. */
// A bare tab is its 28 px minimum: the 16 px glyph and 6 px either side.
const TAB_BOX =
  "flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1.5 text-meta font-medium";
const MORE_BOX = "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-meta font-medium";

interface TabFaceProps {
  tab: PanelTab;
  /** Unread notifications or waiting review requests; 0 for none. */
  count: number;
  /** A terminal is running something. */
  busy: boolean;
  /** The accessible name and tooltip. */
  name: string;
}

/** A tab's icon, its name (collapsed, not removed, when not `named`) and any count. */
function TabFace({
  tab,
  count,
  busy,
  named,
  testIds = false,
}: TabFaceProps & { named: boolean; testIds?: boolean }) {
  return (
    <>
      <span className="relative flex">
        <tab.icon aria-hidden className="size-icon-row" />
        {busy && (
          <span
            aria-hidden
            data-testid={testIds ? "terminal-busy" : undefined}
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-status-working"
          />
        )}
      </span>
      <span aria-hidden data-tab-label className={cn("overflow-hidden", !named && "max-w-0")}>
        <span className="block pl-1.5 whitespace-nowrap">{tab.label}</span>
      </span>
      {count > 0 && (
        <span
          data-testid={
            !testIds
              ? undefined
              : tab.value === "notifications"
                ? "notifications-tab-count"
                : "reviews-tab-count"
          }
          className="ml-1.5 text-muted-foreground tabular-nums"
        >
          {count}
        </span>
      )}
    </>
  );
}

function MoreFace() {
  return (
    <>
      More
      <ChevronDown aria-hidden className="size-icon-chip" />
    </>
  );
}

const MENU_POPUP =
  "z-50 min-w-44 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";
const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[highlighted]:row-cursor";

/**
 * The tabs folded out of a short strip, in strip order, each named with its icon. None has a count:
 * a tab with something waiting stays in the strip.
 */
function MoreTabs({
  faces,
  onPick,
}: {
  faces: readonly TabFaceProps[];
  onPick: (tab: ShownTab) => void;
}) {
  return (
    <Menu.Root>
      <Hint
        label={`More tabs: ${faces.map((f) => f.tab.label).join(", ")}`}
        // Beside it, not under it: back on the trigger after its menu closes, the hint stays open,
        // and under it it would cover the review bar's View menu.
        side="left"
        render={
          <Menu.Trigger
            data-panel-more
            data-testid="panel-more"
            aria-label="More tabs"
            className={cn(
              MORE_BOX,
              "my-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted data-popup-open:text-foreground",
            )}
          />
        }
      >
        <MoreFace />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-surface="overlay" data-testid="panel-more-menu" className={MENU_POPUP}>
            {faces.map((face) => (
              <Menu.Item
                key={face.tab.value}
                data-panel-more-tab={face.tab.value}
                aria-label={face.name}
                className={MENU_ITEM}
                onClick={() => onPick(face.tab.value)}
              >
                <face.tab.icon
                  aria-hidden
                  className="size-icon-row shrink-0 text-muted-foreground"
                />
                {face.tab.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Lets the panel take the chat's place beside the sidebar, and gives the chat back. */
function ExpandToggle() {
  const expanded = useLayoutStore((s) => s.panelExpanded);
  const setExpanded = useLayoutStore((s) => s.setPanelExpanded);
  const restoreHint = useShortcutHint("panel.restore");
  const label = expanded ? "Restore panel width" : "Expand panel";
  return (
    <Hint
      label={expanded ? withHint(label, restoreHint) : label}
      side="top"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          className="ml-auto shrink-0 text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
        />
      }
    >
      {expanded ? <Minimize2 /> : <Maximize2 />}
    </Hint>
  );
}

/**
 * Beside a review's tabs, puts the review in focus, leaving a strip of the chat, and gives the chat
 * back. Its words fold away, leaving the icon, only once the row has no room for them, after every
 * tab's name. Its shortcut is in its tooltip, so the words stay short. The words live in a
 * `[data-action-label]` that collapses rather than unmounts, so they can be measured.
 */
function ReviewFocusAction({ focused, words }: { focused: boolean; words: boolean }) {
  const toggle = useLayoutStore((s) => s.toggleReviewFocus);
  // Narrower than a review reads well beside the chat: the action is offered as an outlined
  // button, its hint saying why, rather than a notice of its own under the tabs.
  const narrow = useLayoutStore((s) => !focused && fitShell(s).reviewNarrow);
  const focusHint = useShortcutHint("review.focus");
  const restoreHint = useShortcutHint("panel.restore");
  const label = focused ? "Restore" : "Focus review";
  const hint = focused ? restoreHint : focusHint;
  return (
    <Hint
      label={
        narrow
          ? `Too narrow to read beside the conversation.\n${withHint("Focus review gives it the window, the conversation a strip beside it", hint)}`
          : withHint(label, hint)
      }
      side="top"
      render={
        <Button
          variant={narrow ? "outline" : "ghost"}
          size="sm"
          aria-label={label}
          data-testid="review-focus"
          data-words={words}
          data-narrow={narrow}
          className={cn(
            "h-7 shrink-0 gap-0 px-1.5 text-meta",
            !narrow && "text-muted-foreground hover:text-foreground",
          )}
          onClick={toggle}
        />
      }
    >
      {focused ? (
        <Minimize2 aria-hidden className="size-icon-row" />
      ) : (
        <Focus aria-hidden className="size-icon-row" />
      )}
      <span aria-hidden data-action-label className={cn("overflow-hidden", !words && "max-w-0")}>
        <span data-action-label-text className="block pl-1.5 whitespace-nowrap">
          {label}
        </span>
      </span>
    </Hint>
  );
}

/** "pnpm dev running", or "pnpm dev and vim running"; empty while no terminal is busy. */
const terminalsBusyText = (processes: ThreadSummary["terminalProcesses"]): string =>
  processes === undefined || processes.length === 0
    ? ""
    : `${processes.map((p) => p.command).join(" and ")} running`;

/** The workspace of the thread in view, whose workers the Workers tab lists; none for a solo one. */
function useRouteWorkspace(): WorkspaceId | undefined {
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  return useThreadsStore((s) =>
    threadId === undefined ? undefined : (s.byId[threadId]?.thread.workspaceId ?? undefined),
  );
}
