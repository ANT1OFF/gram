import {
  chimeOf,
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
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { buildNotice, type AwayNotice } from "./away-notice";
import { scheduleChime } from "./chime";
import { interrupts } from "./interrupt-policy";

// Asks as desktop notifications while the window isn't in front. Each new ask raises one; one answered anywhere is taken back; Allow and
// Merge answer through the stack's own path, and only the very ask that was shown.

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
      if (live.current.has(notice.id)) return;
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
    const open = (notice: AwayNotice) => {
      if (findShownAsk(latest.current, notice) !== undefined)
        useAskStackStore.getState().focus(notice.askKey);
      const threadId = notice.openThreadId;
      if (threadId === undefined) return;
      useLayoutStore.getState().openThread(threadId);
      void navigate({ to: "/t/$threadId", params: { threadId } });
    };
    return bridge.onNotificationAction(({ id, action }) => {
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
