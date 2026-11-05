import { Link, useParams } from "@tanstack/react-router";
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
 * Whether the banner shows in full or as the title bar's chip. A problem shows in full until the
 * user has seen it and moved on (opened another thread), then folds to the chip, on every launch
 * after; the chip opens it again until the next move. Dismiss still removes both.
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
  const { shown, shownKeys, dismiss } = useLaunchIssues();
  const folded = useBannerFold((s) => s.folded);
  const open = useBannerFold((s) => s.open);
  const fresh = shownKeys.some((key) => !folded.includes(key));
  return { shown, shownKeys, dismiss, expanded: shown.length > 0 && (open ?? fresh) };
}

/**
 * The launch checks' problems as the banner and the Settings dot read them: `shown`, the ones not
 * dismissed, which the banner lists; `dismissed`, the ones dismissed that still stand, which Settings
 * carries as a dot until a re-check clears them; and `dismiss`, which saves a dismissal per problem
 * and app version, so it survives restarts; a different check result or an update shows it again.
 * Nothing until the checks, settings and version are in, so a dismissed problem never flashes up.
 */
export function useLaunchIssues(): {
  shown: readonly LaunchIssue[];
  /** The shown problems' keys, per app version (`dismissalKey`). */
  shownKeys: readonly string[];
  dismissed: readonly LaunchIssue[];
  dismiss: () => void;
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
  const dismiss = () => {
    const keys = shown.map((issue) => dismissalKey(version, issue.id));
    setDismissedHere(new Set([...dismissedHere, ...keys]));
    // Dismissals from other versions no longer apply, so they're dropped.
    const kept = saved.filter((key) => key.startsWith(`${version}:`));
    save({ onboarding: { dismissedLaunchIssues: [...new Set([...kept, ...keys])] } }).catch(
      (error: unknown) => console.error("launch checks: save dismissal", error),
    );
  };
  const shownKeys = shown.map((issue) => dismissalKey(version, issue.id));
  return { shown, shownKeys, dismissed, dismiss };
}

/**
 * Mount once in the root layout: what's missing or signed out on this machine, until dismissed.
 * Seen once and left (another thread opened), it folds to the title bar's chip, which opens it again
 * (`useBannerFold`). Dismissed, a problem that still stands leaves both for a dot on Settings (the
 * window's top left), whose hover names it and whose Diagnostics page has it in full.
 */
export function LaunchChecksBanner() {
  const { recheck } = useLaunchChecks();
  const { shown: issues, shownKeys, dismiss, expanded } = useLaunchBanner();
  const [checking, setChecking] = useState(false);
  const cliUpdates = useFeature("cliUpdates", { settled: true });
  useFoldOnMove(expanded, shownKeys);

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
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
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

/** Folds the banner once the user opens another thread while it shows in full. */
function useFoldOnMove(expanded: boolean, keys: readonly string[]) {
  const threadId = useParams({ strict: false }).threadId as string | undefined;
  const last = useRef(threadId);
  // By value, so a fresh array of the same keys re-runs nothing.
  const joined = keys.join("\n");
  useEffect(() => {
    const from = last.current;
    last.current = threadId;
    if (!expanded || from === undefined || threadId === undefined || from === threadId) return;
    useBannerFold.getState().fold(joined.split("\n"));
  }, [threadId, expanded, joined]);
}

/**
 * The banner folded: one small chip in the title bar while a problem stands that the user has seen
 * and not dismissed. Its hover names the problems; a click shows the banner again.
 */
export function LaunchIssuesChip({ className }: { className?: string }) {
  const { shown, expanded } = useLaunchBanner();
  if (shown.length === 0 || expanded) return null;
  const words = shown.length === 1 ? "Setup" : `Setup · ${shown.length}`;
  const list = shown.map((issue) => issue.text.replaceAll("`", "")).join("\n");
  return (
    <Hint
      label={`${list}\nClick to show`}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="sm"
          data-testid="launch-issues-chip"
          aria-label={`Setup problems: ${shown.length}. Show them`}
          onClick={() => useBannerFold.getState().setOpen(true)}
          className={cn("gap-1.5 px-2 text-meta text-muted-foreground", className)}
        />
      }
    >
      <TriangleAlert aria-hidden className="size-3.5" />
      {words}
    </Hint>
  );
}
