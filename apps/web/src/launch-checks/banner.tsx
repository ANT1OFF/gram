import { Link, useRouterState } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { Hint } from "@/components/hint";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDiagnostics, useFeature } from "@/settings/use-diagnostics";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

import { BannerCliUpdate } from "./cli-update";
import { CommandText } from "./command-text";
import { launchIssues, type LaunchIssue } from "./issues";
import { useLaunchChecks } from "./use-launch-checks";

/** A dismissal as `onboarding.dismissedLaunchIssues` stores it. */
const dismissalKey = (version: string, issueId: string): string => `${version}:${issueId}`;

interface BannerFoldState {
  /** The problems (`dismissalKey`) seen in full once, on this machine: they show as the chip. */
  readonly folded: readonly string[];
  /** Opened or closed from the chip, for this window; unset, `folded` decides. */
  readonly open: boolean | undefined;
  fold: (keys: readonly string[]) => void;
  setOpen: (open: boolean) => void;
}

/**
 * Whether the banner shows in full or as the title bar's chip. A problem shows in full once: the
 * first time it is up, until the user does anything else (goes to another page, or clicks or types
 * outside it). Then it folds to the chip, on every launch after; the chip opens it again until the
 * next such move. Dismiss removes both.
 */
export const useBannerFold = create<BannerFoldState>()(
  persist(
    (set) => ({
      folded: [],
      open: undefined,
      fold: (keys) =>
        set((s) => ({ open: undefined, folded: [...new Set([...s.folded, ...keys])].slice(-32) })),
      setOpen: (open) => set({ open }),
    }),
    {
      name: "gram.launch-banner",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ folded }) => ({ folded }),
    },
  ),
);

/**
 * The problems the banner lists and whether it shows them in full (`expanded`) or folded into the
 * title bar's chip, with the keys that fold it.
 */
export function useLaunchBanner() {
  const { shown, shownKeys, dismiss, cleared, dropCleared } = useLaunchIssues();
  const folded = useBannerFold((s) => s.folded);
  const open = useBannerFold((s) => s.open);
  const fresh = shownKeys.some((key) => !folded.includes(key));
  return {
    shown,
    shownKeys,
    dismiss,
    cleared,
    dropCleared,
    expanded: shown.length > 0 && (open ?? fresh),
  };
}

/**
 * The launch checks' problems as the banner and the Settings dot read them: `shown`, the ones not
 * dismissed, which the banner lists; `dismissed`, the ones dismissed that still stand, which Settings
 * carries as a dot until a re-check clears them; and `dismiss`, which saves a dismissal per problem
 * and app version, so it survives restarts; a different check result, an update, or the problem
 * clearing and coming back shows it again.
 * Nothing until the checks, settings and version are in, so a dismissed problem never flashes up.
 */
export function useLaunchIssues(): {
  shown: readonly LaunchIssue[];
  /** The shown problems' keys, per app version (`dismissalKey`). */
  shownKeys: readonly string[];
  dismissed: readonly LaunchIssue[];
  dismiss: () => void;
  /** Whether a saved dismissal's problem has cleared, so `dropCleared` should forget it. */
  cleared: boolean;
  dropCleared: () => void;
} {
  const { checks } = useLaunchChecks();
  const diagnostics = useDiagnostics();
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  // Hides at once, before the save lands or when it fails.
  const [dismissedHere, setDismissedHere] = useState<ReadonlySet<string>>(new Set());
  const ready = checks !== undefined && settings !== undefined && !diagnostics.isPending;
  const version = diagnostics.data?.version ?? "";
  const saved = settings?.onboarding.dismissedLaunchIssues ?? [];
  const all = ready ? launchIssues(checks) : [];
  const gone = new Set([...saved, ...dismissedHere]);
  const isDismissed = (issue: LaunchIssue) => gone.has(dismissalKey(version, issue.id));
  const shown = all.filter((issue) => !isDismissed(issue));
  const dismissed = all.filter(isDismissed);
  // A dismissal holds while its problem stands: one that cleared (gh signed in, say) is dropped,
  // so the problem coming back later shows again. Dismissals from other versions are dropped too.
  const standing = new Set(all.map((issue) => dismissalKey(version, issue.id)));
  const kept = saved.filter((key) => standing.has(key));
  const cleared = ready && kept.length < saved.length;
  const dropCleared = () =>
    save({ onboarding: { dismissedLaunchIssues: kept } }).catch((error: unknown) =>
      console.error("launch checks: drop cleared dismissals", error),
    );
  const dismiss = () => {
    const keys = shown.map((issue) => dismissalKey(version, issue.id));
    setDismissedHere(new Set([...dismissedHere, ...keys]));
    save({ onboarding: { dismissedLaunchIssues: [...new Set([...kept, ...keys])] } }).catch(
      (error: unknown) => console.error("launch checks: save dismissal", error),
    );
  };
  const shownKeys = shown.map((issue) => dismissalKey(version, issue.id));
  return { shown, shownKeys, dismissed, dismiss, cleared, dropCleared };
}

/**
 * Mount once in the root layout: what's missing or signed out on this machine, until dismissed.
 * Shown once, it folds to the title bar's chip at the user's next move, which opens it again
 * (`useBannerFold`). Dismissed, a problem that still stands leaves both for a dot on Settings (the
 * window's top left), whose hover names it and whose Diagnostics page has it in full.
 */
export function LaunchChecksBanner() {
  const { recheck } = useLaunchChecks();
  const { shown: issues, shownKeys, dismiss, expanded, cleared, dropCleared } = useLaunchBanner();
  const [checking, setChecking] = useState(false);
  const cliUpdates = useFeature("cliUpdates", { settled: true });
  useFoldAfterShowing(expanded, shownKeys);
  // Once per change, from the one banner the shell mounts rather than every reader of the issues.
  useEffect(() => {
    if (cleared) dropCleared();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cleared]);

  if (!expanded) return null;

  const runRecheck = async () => {
    setChecking(true);
    try {
      await recheck();
    } catch {
      // The previous result stays up; Diagnostics shows the details.
    } finally {
      setChecking(false);
    }
  };

  return (
    <aside
      aria-label="Setup problems"
      data-testid="launch-checks-banner"
      className="flex shrink-0 items-start gap-3 border-b border-edge bg-card px-4 py-2 text-reading text-card-foreground"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-icon-row shrink-0 text-warning" />
      <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
        {issues.map((issue) => (
          <li key={issue.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0">
              <CommandText text={issue.text} />
            </span>
            {cliUpdates && issue.update !== undefined && <BannerCliUpdate agent={issue.update} />}
          </li>
        ))}
      </ul>
      <div className="flex shrink-0 gap-1">
        <Button
          size="sm"
          variant="ghost"
          render={<Link to="/settings/diagnostics" />}
          nativeButton={false}
        >
          Details
        </Button>
        <Button size="sm" variant="ghost" disabled={checking} onClick={() => void runRecheck()}>
          {checking ? "Checking…" : "Re-check"}
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Dismiss
        </Button>
      </div>
    </aside>
  );
}

/** The banner, by the attribute only it carries. */
const BANNER = '[data-testid="launch-checks-banner"]';

/**
 * Folds the banner at the user's first move once it has shown: another page, or a click or key
 * outside it. The fold waits for the move's own handlers, so a click lands where it was aimed
 * before the banner's row leaves the layout.
 */
function useFoldAfterShowing(expanded: boolean, keys: readonly string[]) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shownOn = useRef<string | undefined>(undefined);
  // By value, so a fresh array of the same keys re-runs nothing.
  const joined = keys.join("\n");
  useEffect(() => {
    if (!expanded) {
      shownOn.current = undefined;
      return;
    }
    const fold = () => useBannerFold.getState().fold(joined.split("\n"));
    if (shownOn.current === undefined) shownOn.current = pathname;
    else if (shownOn.current !== pathname) return fold();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elsewhere = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(BANNER) !== null) return;
      timer ??= setTimeout(fold);
    };
    document.addEventListener("click", elsewhere, true);
    document.addEventListener("keydown", elsewhere, true);
    return () => {
      document.removeEventListener("click", elsewhere, true);
      document.removeEventListener("keydown", elsewhere, true);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [expanded, joined, pathname]);
}

/**
 * The banner folded: one icon in the title bar, which is icon-only, while a problem stands that the
 * user has seen and not dismissed. Its hover says how many and names them; a click shows the banner
 * again. The banner and the chip never show at once: the chip is the banner's folded self.
 */
export function LaunchIssuesChip({ className }: { className?: string }) {
  const { shown, expanded } = useLaunchBanner();
  if (shown.length === 0 || expanded) return null;
  const heading = shown.length === 1 ? "Setup problem" : `${shown.length} setup problems`;
  const list = shown.map((issue) => issue.text.replaceAll("`", "")).join("\n");
  return (
    <Hint
      label={`${heading}\n${list}\nClick to show`}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="launch-issues-chip"
          data-count={shown.length}
          aria-label={`${heading}. Show them`}
          onClick={() => useBannerFold.getState().setOpen(true)}
          className={cn("shrink-0 text-muted-foreground", className)}
        />
      }
    >
      <TriangleAlert aria-hidden />
    </Hint>
  );
}
