import type { AppUpdateState, UpdateChannel, UpdateSource } from "@gram/contracts";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/motion/spinner";
import { nativeUpdates } from "@/updates/native";
import { nativeSourceNote } from "@/updates/source-copy";
import { notesPreview, statusLine } from "@/updates/update-pill-view";

import { Toggle } from "./fields";

/** The one next step for the state, as the pill offers it, with its button's words. */
function nextStep(state: AppUpdateState): { label: string; run: () => void } | undefined {
  const available = state.availableVersion;
  const downloaded = state.downloadedVersion;
  if (state.status === "available" && available)
    return { label: `Download ${available}`, run: () => void nativeUpdates.download() };
  if (state.status === "ready" && downloaded)
    return { label: "Restart to update", run: () => void nativeUpdates.install(downloaded) };
  if (state.status === "error" && state.errorStep === "install" && downloaded)
    return { label: "Try the restart again", run: () => void nativeUpdates.install(downloaded) };
  if (state.status === "error" && state.errorStep === "download" && available)
    return { label: "Try the download again", run: () => void nativeUpdates.download() };
  return undefined;
}

/**
 * Settings → Updates on a Developer ID signed install: the same states as the update pill, from
 * Electron's updater in main. Checking, downloading and restarting are each asked for; nothing
 * restarts on its own.
 */
export function NativeUpdatesSection({
  state,
  source,
  channel,
  automaticChecks,
  onAutomaticChecksChange,
}: {
  state: AppUpdateState;
  /** Where the updater reads releases; undefined until the shell answers, or in older shells. */
  source?: UpdateSource | undefined;
  /** The channel checks run on; Settings offers no choice of it. */
  channel: UpdateChannel;
  automaticChecks: boolean;
  onAutomaticChecksChange?: ((value: boolean) => void) | undefined;
}) {
  const busy =
    state.status === "checking" || state.status === "downloading" || state.status === "installing";
  const step = nextStep(state);
  const problem = state.status === "error" ? state.message : null;
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="updates" data-native="true">
      <div className="rounded-md border border-border bg-card p-3" data-testid="native-status">
        <p className="font-medium">Running Gram {state.currentVersion}</p>
        <p className="mt-1 flex items-center gap-1.5 text-muted-foreground" aria-live="polite">
          {busy && <Spinner aria-hidden className="size-3.5" />}
          {statusLine(state)}
        </p>
        {state.status === "downloading" && (
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(state.percent ?? 0)}
            className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary motion-safe:transition-[width] motion-safe:duration-150"
              style={{ width: `${Math.floor(state.percent ?? 0)}%` }}
            />
          </div>
        )}
      </div>

      {state.notApplied && (
        <div
          role="status"
          data-testid="not-applied"
          className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md border border-border p-3"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1">
            Gram {state.notApplied.version} wasn't applied. {state.notApplied.reason}
          </p>
          <Button size="xs" variant="ghost" onClick={() => void nativeUpdates.dismiss()}>
            Dismiss
          </Button>
        </div>
      )}

      <Toggle
        label="Check for updates automatically"
        checked={automaticChecks}
        description="Checks 15 s after launch and then every 4 minutes. Never downloads or restarts on its own."
        disabled={!onAutomaticChecksChange}
        onChange={(value) => onAutomaticChecksChange?.(value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={step ? "ghost" : "default"}
          disabled={busy}
          onClick={() => void nativeUpdates.check(channel)}
        >
          {state.status === "checking" ? "Checking…" : "Check for updates"}
        </Button>
        {step && (
          <Button size="sm" disabled={busy || !state.canInstall} onClick={step.run}>
            {step.label}
          </Button>
        )}
      </div>

      {state.status === "installing" && state.message && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5" data-testid="update-held">
          <p className="min-w-0 flex-1 text-muted-foreground">{state.message}</p>
          {/* A held restart or a pending earlier install: try again to remove what macOS holds. */}
          <Button size="xs" variant="ghost" onClick={() => void nativeUpdates.dismiss()}>
            Try again
          </Button>
        </div>
      )}

      {problem && (
        <p role="alert" className="flex items-start gap-1.5 text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {problem}
        </p>
      )}

      {state.releaseNotes && (state.status === "available" || state.status === "ready") && (
        <section aria-label="Release notes" className="rounded-md border border-border p-3">
          <p className="mb-1 font-medium">What's in {state.availableVersion}</p>
          <p className="max-h-48 overflow-auto whitespace-pre-line text-muted-foreground">
            {notesPreview(state.releaseNotes)}
          </p>
        </section>
      )}

      <p className="text-muted-foreground">
        {nativeSourceNote(source?.repo)} macOS installs an update only when it's signed by the same
        Developer ID team as this app. Restarting saves sessions and stops running agents first; if
        one can't stop cleanly, nothing restarts.
      </p>
      {!state.canInstall && (
        <p className="text-muted-foreground">
          Gram updates itself only from Applications. Move it there to restart into updates.
        </p>
      )}
    </div>
  );
}
