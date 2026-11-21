import { useEffect, useEffectEvent, useMemo, useRef } from "react";

import { useNow } from "@/lib/use-now";
import { askKeysByThread } from "@/orchestration/ask-model";
import { askTotals, useWorkspaceAsks, type WorkspaceAsks } from "@/orchestration/ask-stack";
import { useOrchestratorLedgers } from "@/orchestration/use-orchestration";
import { startOfDay, workersByTab } from "@/orchestration/workers-model";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { useSame } from "@/stores/use-same";

import { shouldEnterQuiet, type StripWorkspace } from "./quiet-model";
import { useViewStore } from "./view-store";

/**
 * The strip's workspaces: each one's Now workers, its asks, and what merged today. The menu bar's
 * workspace lines count from it too.
 */
export function useQuietStrip(all: readonly WorkspaceAsks[]): StripWorkspace[] {
  const ids = useMemo(() => all.map((w) => w.workspaceId), [all]);
  const ledgers = useOrchestratorLedgers(ids);
  const now = useNow(true, undefined, 60_000);
  return useThreadsStore(
    useSame(({ byId, statusDetail }) =>
      all.map((w) => {
        const asking = new Set(askKeysByThread(w.asks).keys());
        const tabs = workersByTab(ledgers.get(w.workspaceId), {
          byId,
          statusDetail,
          now,
          asking,
        });
        return {
          workspaceId: w.workspaceId,
          name: w.name,
          orchestratorThreadId: w.orchestratorThreadId,
          workers: tabs.now.flatMap((feature) => feature.rows),
          asks: w.asks.length,
          mergedToday: tabs.done
            .flatMap((feature) => feature.rows)
            .filter((row) => row.glyph === "merged" && (row.finishedAt ?? 0) >= startOfDay(now))
            .length,
        };
      }),
    ),
  );
}

const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;

/**
 * Called once per window by the shell, in and out of Quiet. With Quiet when idle on, the window
 * drops into Quiet by itself after `QUIET_IDLE_MS` without a key, click or move while nothing is
 * asked. Leaving is the user's: Esc, Leave quiet, or any view's key.
 */
export function useQuietMode(): void {
  const enabled = useServerSettings((s) => s.settings?.layout?.quietWhenIdle === true);
  const available = useServerSettings((s) => s.settings !== undefined);
  const asks = askTotals(useWorkspaceAsks()).count;
  const lastActive = useRef(0);
  const check = useEffectEvent(() => {
    const { quiet, setQuiet } = useViewStore.getState();
    if (
      shouldEnterQuiet({
        enabled,
        available,
        quiet,
        asks,
        idleFor: Date.now() - lastActive.current,
      })
    ) {
      setQuiet(true);
    }
  });
  useEffect(() => {
    if (!enabled || !available) return;
    lastActive.current = Date.now();
    const touched = () => {
      lastActive.current = Date.now();
    };
    for (const type of ACTIVITY) window.addEventListener(type, touched, true);
    const timer = setInterval(() => check(), 15_000);
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, touched, true);
      clearInterval(timer);
    };
  }, [enabled, available]);
  useEffect(() => {
    if (asks > 0) lastActive.current = Date.now();
  }, [asks]);
}
