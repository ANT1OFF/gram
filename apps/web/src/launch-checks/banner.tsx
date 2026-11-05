import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useDiagnostics, useFeature } from "@/settings/use-diagnostics";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

import { BannerCliUpdate } from "./cli-update";
import { CommandText } from "./command-text";
import { launchIssues, type LaunchIssue } from "./issues";
import { useLaunchChecks } from "./use-launch-checks";

/** A dismissal as `onboarding.dismissedLaunchIssues` stores it. */
const dismissalKey = (version: string, issueId: string): string => `${version}:${issueId}`;

/**
 * The launch checks' problems as the banner and the Settings dot read them: `shown`, the ones not
 * dismissed, which the banner lists; `dismissed`, the ones dismissed that still stand, which Settings
 * carries as a dot until a re-check clears them; and `dismiss`, which saves a dismissal per problem
 * and app version, so it survives restarts; a different check result or an update shows it again.
 * Nothing until the checks, settings and version are in, so a dismissed problem never flashes up.
 */
export function useLaunchIssues(): {
  shown: readonly LaunchIssue[];
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
  return { shown, dismissed, dismiss };
}

/**
 * Mount once in the root layout: what's missing or signed out on this machine, until dismissed.
 * Dismissed, a problem that still stands leaves the full-width row for a dot on Settings (the
 * window's top left), whose hover names it and whose Diagnostics page has it in full.
 */
export function LaunchChecksBanner() {
  const { recheck } = useLaunchChecks();
  const { shown: issues, dismiss } = useLaunchIssues();
  const [checking, setChecking] = useState(false);
  const cliUpdates = useFeature("cliUpdates", { settled: true });

  if (issues.length === 0) return null;

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
      className="flex shrink-0 items-start gap-3 border-b border-border bg-card px-4 py-2 text-reading text-card-foreground"
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
