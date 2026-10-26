import type { ThreadId, ThreadSummary } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import {
  Bell,
  FileDiff,
  FolderTree,
  GitPullRequest,
  Globe,
  Hand,
  Inbox,
  Maximize2,
  Minimize2,
  Plug,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { useNotificationHistory, unreadNotifications } from "@/stores/notifications";
import { PreviewSuggestionNotice } from "@/panels/preview-suggestion";
import { useReviewRequests } from "@/reviews/review-requests";
import { useFeature } from "@/settings/use-diagnostics";
import { useToastDock } from "@/shell/toast-dock";
import { reviewsTabShown, useLayoutStore, type RightPanelTab } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import type * as PanelTabs from "./right-panel-tabs";

const TABS: { value: RightPanelTab; label: string; icon: LucideIcon }[] = [
  { value: "diff", label: "Diff", icon: FileDiff },
  { value: "pr", label: "PR", icon: GitPullRequest },
  { value: "files", label: "Files", icon: FolderTree },
  { value: "terminal", label: "Terminal", icon: SquareTerminal },
  { value: "preview", label: "Preview", icon: Globe },
  { value: "connectors", label: "Connectors", icon: Plug },
  { value: "reviews", label: "Reviews", icon: Inbox },
  { value: "notifications", label: "Notifications", icon: Bell },
  { value: "needsYou", label: "Needs you", icon: Hand },
];

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
  // Only review requests count as waiting: the user's own open PRs wait on others.
  const notificationCount = useNotificationHistory(unreadNotifications);
  const reviewCount = useReviewRequests().data?.requests.length ?? 0;
  // The tab is synced between machines and the list's placement is not, so the stored tab can name
  // a Reviews tab this window doesn't have, or a Preview tab where the shell has no preview.
  const tab =
    (storedTab === "reviews" && !reviewsHere) || (storedTab === "preview" && !previewHere)
      ? "diff"
      : storedTab;
  const setTab = useLayoutStore((s) => s.setPanelTab);
  const tabList = useRef<HTMLDivElement>(null);
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

  return (
    <aside
      data-testid="right-panel"
      data-surface="chrome"
      className="flex min-h-0 flex-1 flex-col border-l border-border bg-panel"
    >
      <div className="h-(--titlebar-height) shrink-0 [-webkit-app-region:drag]" />
      <PreviewSuggestionNotice threadId={threadId} />
      <Tabs
        value={tab}
        onValueChange={(value: RightPanelTab) => setTab(value)}
        className="min-h-0 flex-1"
      >
        <div className="flex items-center border-b border-border">
          <TabsList ref={tabList} className="min-w-0 flex-1 overflow-x-auto border-b-0">
            {/* An icon each, and the name only on the open one: all names don't fit a narrow panel. */}
            {TABS.filter(
              (t) =>
                (t.value !== "reviews" || reviewsHere) && (t.value !== "preview" || previewHere),
            ).map((t) => {
              const count =
                t.value === "notifications"
                  ? notificationCount
                  : t.value === "reviews" && requestsHere
                    ? reviewCount
                    : 0;
              const busy = t.value === "terminal" && busyTerminals !== "";
              const label = busy ? `${t.label}: ${busyTerminals}` : t.label;
              return (
                <Hint
                  key={t.value}
                  label={label}
                  side="bottom"
                  render={
                    <TabsTrigger
                      value={t.value}
                      data-panel-tab={t.value}
                      aria-label={
                        count > 0
                          ? `${t.label}, ${count} ${t.value === "notifications" ? "unread" : "waiting"}`
                          : label
                      }
                      className="flex shrink-0 items-center gap-1.5"
                    />
                  }
                >
                  <span className="relative flex">
                    <t.icon aria-hidden className="size-3.5" />
                    {busy && (
                      <span
                        aria-hidden
                        data-testid="terminal-busy"
                        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-status-working"
                      />
                    )}
                  </span>
                  {t.value === tab && <span>{t.label}</span>}
                  {count > 0 && (
                    <span
                      data-testid={
                        t.value === "notifications"
                          ? "notifications-tab-count"
                          : "reviews-tab-count"
                      }
                      className="text-muted-foreground tabular-nums"
                    >
                      {count}
                    </span>
                  )}
                </Hint>
              );
            })}
          </TabsList>
          <ExpandToggle />
        </div>
        <Suspense fallback={null}>
          <RightPanelTabs
            threadId={threadId}
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

/** Lets the panel take the chat's place beside the sidebar, and gives the chat back. */
function ExpandToggle() {
  const expanded = useLayoutStore((s) => s.panelExpanded);
  const setExpanded = useLayoutStore((s) => s.setPanelExpanded);
  const restoreHint = useShortcutHint("panel.restore");
  const label = expanded ? "Restore panel width" : "Expand panel";
  return (
    <Hint
      label={expanded ? withHint(label, restoreHint) : label}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="mr-2 shrink-0 text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
        />
      }
    >
      {expanded ? <Minimize2 /> : <Maximize2 />}
    </Hint>
  );
}

/** "pnpm dev running", or "pnpm dev and vim running"; empty while no terminal is busy. */
const terminalsBusyText = (processes: ThreadSummary["terminalProcesses"]): string =>
  processes === undefined || processes.length === 0
    ? ""
    : `${processes.map((p) => p.command).join(" and ")} running`;
