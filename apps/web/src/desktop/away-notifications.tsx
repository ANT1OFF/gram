import {
  chimeOf,
  gatherAsksOn,
  helperOn,
  noticeActionsOn,
  workspaceMuted,
  type Settings,
  type WorkspaceId,
} from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useApi } from "@/api/context";
import { showInboxAsk } from "@/inbox/inbox-store";
import type { Api } from "@/api/types";
import type { Ask } from "@/orchestration/ask-model";
import {
  askFingerprint,
  checkAwayAction,
  findShownAsk,
  scopedIds,
} from "@/orchestration/ask-actions";
import { holdAnswer } from "@/orchestration/ask-answer";
import { useWorkspaceAsks, type WorkspaceAsks } from "@/orchestration/ask-stack";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { buildNotice, buildSummary, SUMMARY_ID, type AwayNotice } from "./away-notice";
import { scheduleChime } from "./chime";
import { interrupts } from "./interrupt-policy";

// Asks as desktop notifications while the window isn't in front. The first raises its own; one answered anywhere is taken back; Allow and
// Merge answer through the stack's own path, and only the very ask that was shown. A second that
// arrives while the first still waits joins it in one notification that lists them all (Settings →
// Notifications → Gather waiting asks), which opens the Inbox and answers nothing.

/** Asks already open as the window loads are the stack's, not news. */
const STARTUP_GRACE_MS = 5_000;
/** How long a helper title may take before the template's goes out instead. */
const TITLE_TIMEOUT_MS = 4_000;
/** Request ids remembered as seen, so an ask that comes back (undo, a failed send) stays quiet. */
const SEEN_LIMIT = 5_000;

const toast = (title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind: "info", title, body });

/** Whether `workspaceId`'s asks may notify at all. */
const notifies = (settings: Settings | undefined, workspaceId: WorkspaceId): settings is Settings =>
  settings !== undefined &&
  settings.notifications.native !== false &&
  !workspaceMuted(settings, workspaceId) &&
  interrupts("ask");

/** The helper's title for `ask`, or `undefined` for the template's: off, slow or none. */
const helperTitle = async (api: Api, ask: Ask, settings: Settings) => {
  const entry = ask.group?.entries[0];
  if (entry === undefined || !helperOn(settings, "notice")) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TITLE_TIMEOUT_MS);
  });
  try {
    const title = await Promise.race([
      api.requestNoticeTitle(entry.threadId, entry.request.id, ask.count),
      late,
    ]);
    return title ?? undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** Raises, takes back and answers asks' desktop notifications. Mounted only in the desktop shell. */
export function AwayNotifications({
  graceMs = STARTUP_GRACE_MS,
}: {
  /** Asks open this long after mount are the stack's; a test can shorten it. */
  graceMs?: number;
} = {}) {
  const all = useWorkspaceAsks();
  const settings = useServerSettings((s) => s.settings);
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const latest = useRef(all);
  const mountedAt = useRef<number | undefined>(undefined);
  /** Request (or question) ids already seen. */
  const seen = useRef(new Set<string>());
  /** Notifications on screen or in Notification Center, by id. */
  const live = useRef(new Map<string, AwayNotice>());
  /** The asks the one shared notification stands for, by their own notice's id; empty when it isn't up. */
  const gathered = useRef(new Map<string, AwayNotice>());

  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  useEffect(() => {
    latest.current = all;
    const bridge = window.gram;
    if (!bridge) return;
    // Answered anywhere, held for undo, or changed: gone from the notification too.
    for (const [id, notice] of live.current) {
      if (findShownAsk(all, notice) !== undefined) continue;
      live.current.delete(id);
      bridge.withdrawNotification?.(id);
    }
    // The shared one stands until the last ask it lists is gone; it isn't raised again as they go.
    if (gathered.current.size > 0) {
      for (const [id, notice] of gathered.current) {
        if (findShownAsk(all, notice) === undefined) gathered.current.delete(id);
      }
      if (gathered.current.size === 0) bridge.withdrawNotification?.(SUMMARY_ID);
    }
    const quiet = performance.now() - (mountedAt.current ?? 0) < graceMs;
    for (const workspace of all) {
      for (const ask of workspace.asks) {
        const ids = scopedIds(ask, workspace.workspaceId);
        const fresh = ids.some((id) => !seen.current.has(id));
        for (const id of ids) seen.current.add(id);
        if (!fresh || quiet || document.hasFocus()) continue;
        if (!notifies(settings, workspace.workspaceId)) continue;
        void raise(ask, workspace);
      }
    }
    if (seen.current.size > SEEN_LIMIT) {
      const keep = new Set(
        all.flatMap((workspace) =>
          workspace.asks.flatMap((ask) => scopedIds(ask, workspace.workspaceId)),
        ),
      );
      seen.current = new Set([...seen.current].filter((id) => keep.has(id)));
    }

    async function raise(ask: Ask, workspace: WorkspaceAsks) {
      const before = useServerSettings.getState().settings;
      if (before === undefined) return;
      const shown = {
        workspaceId: workspace.workspaceId,
        askKey: ask.key,
        fingerprint: askFingerprint(ask),
      };
      const title = await helperTitle(api, ask, before);
      // The very ask the title was asked for, unchanged, with settings as they stand now. Gone or
      // changed meanwhile, even to another request that took the same id, it shows nothing.
      const now = findShownAsk(latest.current, shown);
      const prefs = useServerSettings.getState().settings;
      if (now === undefined || document.hasFocus() || !notifies(prefs, workspace.workspaceId))
        return;
      const notice = buildNotice({
        ask: now.ask,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.name,
        orchestratorThreadId: workspace.orchestratorThreadId,
        title,
        actions: noticeActionsOn(prefs),
      });
      if (live.current.has(notice.id) || gathered.current.has(notice.id)) return;
      if (gatherAsksOn(prefs) && live.current.size + gathered.current.size > 0) {
        // Something already waits: this one joins it, and those up singly give way to the one.
        const first = gathered.current.size === 0;
        for (const [id, single] of live.current) {
          gathered.current.set(id, single);
          window.gram?.withdrawNotification?.(id);
        }
        live.current.clear();
        gathered.current.set(notice.id, notice);
        const summary = buildSummary([...gathered.current.values()]);
        window.gram?.withdrawNotification?.(SUMMARY_ID);
        window.gram?.notify({
          id: SUMMARY_ID,
          title: summary.title,
          subtitle: summary.subtitle,
          body: summary.body,
          ...(summary.openThreadId === undefined ? {} : { threadId: summary.openThreadId }),
        });
        // One chime as it forms; the asks that join it later arrive quietly.
        if (first) scheduleChime(chimeOf(prefs.notifications));
        return;
      }
      live.current.set(notice.id, notice);
      window.gram?.notify({
        id: notice.id,
        title: notice.title,
        subtitle: notice.subtitle,
        body: notice.body,
        ...(notice.button === undefined ? {} : { actions: [notice.button.label] }),
        ...(notice.openThreadId === undefined ? {} : { threadId: notice.openThreadId }),
      });
      scheduleChime(chimeOf(prefs.notifications));
    }
  }, [all, settings, api, graceMs]);

  useEffect(() => {
    const bridge = window.gram;
    if (!bridge?.onNotificationAction) return;
    // The thread it came from, with the Inbox over it on that ask while it still waits.
    const open = (notice: AwayNotice) => {
      const threadId = notice.openThreadId;
      if (threadId !== undefined) {
        useLayoutStore.getState().openThread(threadId);
        void navigate({ to: "/t/$threadId", params: { threadId } });
      }
      if (findShownAsk(latest.current, notice) !== undefined) showInboxAsk(notice.askKey);
    };
    return bridge.onNotificationAction(({ id, action }) => {
      if (id === SUMMARY_ID) {
        // Open only: the oldest ask it lists that still waits, in the Inbox with the rest.
        const waiting = [...gathered.current.values()].find(
          (each) => findShownAsk(latest.current, each) !== undefined,
        );
        gathered.current.clear();
        if (waiting !== undefined) open(waiting);
        return;
      }
      const notice = live.current.get(id);
      if (notice === undefined) return;
      live.current.delete(id);
      if (action === "open") return open(notice);
      // Only the very ask that was shown, still waiting, with actions still on: anything else
      // sends nothing.
      const checked = action === 0 ? checkAwayAction(latest.current, notice) : undefined;
      const prefs = useServerSettings.getState().settings;
      if (
        checked === undefined ||
        prefs === undefined ||
        !noticeActionsOn(prefs) ||
        !notifies(prefs, checked.workspace.workspaceId)
      ) {
        toast("Nothing sent", "That ask changed or was answered. Open Gram to see it.");
        return;
      }
      holdAnswer(api, checked.ask, checked.done, checked.action, (workspaceId) => {
        void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
      });
    });
  }, [api, navigate, queryClient]);

  return null;
}
