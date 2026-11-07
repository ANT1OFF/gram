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

// What the shell keeps of Quiet while it isn't shown: dropping into it when idle, and the strip's
// counts the menu bar reads. Quiet itself (`QuietView`) loads when it's entered.

/**
 * The strip's workspaces: each one's Now workers, its asks, and what merged today. The menu bar's
 * workspace lines count from it too.
 */
export function useQuietStrip(all: readonly WorkspaceAsks[]): StripWorkspace[] {
  const ids = useMemo(() => all.map((w) => w.workspaceId), [all]);
  const ledgers = useOrchestratorLedgers(ids);
  // Minute resolution is enough for "today".
  const now = useNow(true, undefined, 60_000);
  // Only the strip: a thread's change that leaves it reading the same leaves its readers still.
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

/** What counts as the user being at the window. */
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;

/**
 * Called once per window by the shell, in and out of Quiet. With Quiet when idle on, the window
 * drops into Quiet by itself after `QUIET_IDLE_MS` without a key, click or move while nothing is
 * asked. Leaving is the user's: Esc, Leave quiet, or any view's key.
 */
export function useQuietMode(): void {
  const enabled = useServerSettings((s) => s.settings?.layout?.quietWhenIdle === true);
  // Not before the settings have loaded, which say whether Quiet when idle is on.
  const available = useServerSettings((s) => s.settings !== undefined);
  const asks = askTotals(useWorkspaceAsks()).count;
  // Set when the watch starts, below.
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
  // An ask arriving restarts the wait: the window shouldn't go quiet right after one is answered.
  useEffect(() => {
    if (asks > 0) lastActive.current = Date.now();
  }, [asks]);
}
