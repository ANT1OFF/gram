import type { ReleaseInfo, UpdateChannel, UpdateCheck } from "@gram/contracts";
import { useEffect, useState } from "react";

import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { pinForInstall } from "@/updates/launch-check";
import { BuildStatus, ReleaseNotes } from "@/updates/build-status";
import { ghSourceCopy, useUpdateSource } from "@/updates/source-copy";
import { useUpdateStore } from "@/updates/store";

import { Toggle } from "./fields";
import { NativeUpdatesSection } from "./native-updates-section";

const RELATION_ACTION: Record<ReleaseInfo["relation"], string | undefined> = {
  newer: "Install",
  older: "Downgrade",
  current: undefined,
};

export interface UpdatesSectionProps {
  automaticChecks?: boolean;
  onPreferencesChange?: (patch: { automaticChecks?: boolean }) => Promise<unknown>;
  /**
   * The persisted channel, Stable while it's absent or still loading. Settings offers no other:
   * the public repository publishes no pre-releases.
   */
  channel?: UpdateChannel | undefined;
  /** A version the user deliberately installed; automatic notices stay quiet while it runs. */
  pinnedVersion?: string | undefined;
  /** Persists a new pin (`null` removes it); an install waits for it. */
  onPinChange?: ((pin: string | null) => Promise<unknown>) | undefined;
}

/**
 * Settings → Updates over the desktop bridge: a Developer ID signed Mac's Electron updater, or
 * else check for releases, list them, and install on builds that can (Windows) or open the
 * release page. Installing anything but the newest release pins it. An unsigned Mac has no in-app
 * updater: its checks say so. Browser dev mode has no bridge and shows a notice.
 */
export function UpdatesSection({
  automaticChecks = false,
  onPreferencesChange,
  channel = "stable",
  pinnedVersion,
  onPinChange,
}: UpdatesSectionProps = {}) {
  const bridge = window.gram;
  const native = useUpdateStore((s) => s.native);
  const source = useUpdateSource();
  const copy = ghSourceCopy(source);
  const check = useUpdateStore((s) => s.latest);
  const [checking, setChecking] = useState(false);
  const progress = useUpdateStore((s) => s.progress);
  const installingTag = useUpdateStore((s) => s.installingTag);
  const busy =
    installingTag !== undefined || (progress !== undefined && progress.stage !== "failed");
  const [error, setError] = useState<string>();
  const targetTag = progress?.tag ?? installingTag ?? check?.tag;
  const notesRelease = check?.releases?.find((r) => r.tag === targetTag) ?? check?.releases?.[0];
  const releasePage =
    check?.releases?.find((r) => r.tag === targetTag)?.htmlUrl ??
    (check?.tag === targetTag ? check?.htmlUrl : undefined);

  useEffect(
    () => bridge?.updates.onProgress((value) => useUpdateStore.setState({ progress: value })),
    [bridge],
  );

  if (!bridge) {
    return <p className="text-sm text-muted-foreground">Updates are managed by the desktop app.</p>;
  }
  // A Developer ID signed install updates through Electron's updater; the rest of this page is
  // the `gh` updater's. Until main has said which this install uses, show neither.
  if (native === undefined && bridge.updates.native)
    return <p className="text-sm text-muted-foreground">Reading the update status…</p>;
  if (native) {
    return (
      <NativeUpdatesSection
        state={native}
        source={source}
        channel={channel}
        automaticChecks={automaticChecks}
        onAutomaticChecksChange={
          onPreferencesChange &&
          ((value) =>
            void onPreferencesChange({ automaticChecks: value }).catch((e: unknown) =>
              setError(errorMessage(e)),
            ))
        }
      />
    );
  }

  const runCheck = async () => {
    setChecking(true);
    setError(undefined);
    if (useUpdateStore.getState().progress?.stage === "failed")
      useUpdateStore.setState({ progress: undefined });
    try {
      useUpdateStore.setState({ latest: await bridge.updates.check(channel) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const install = async (release: ReleaseInfo) => {
    setError(undefined);
    useUpdateStore.setState({ installingTag: release.tag, progress: undefined });
    const previous = pinnedVersion ?? null;
    const pin = pinForInstall(check?.releases ?? [], release.tag);
    try {
      // Stored first: a successful install exits the app before a later write could land. A pin is
      // stored again even when it's the saved one, since the shell checks the copy the server
      // mirrors, which a failed mirror write leaves behind.
      if (pin !== previous || pin !== null) await onPinChange?.(pin);
      const result = await bridge.updates.install({
        channel: check?.channel ?? channel,
        tag: release.tag,
        downgrade: release.relation === "older",
        ...(release.installId ? { installId: release.installId } : {}),
      });
      if (result.updating) {
        useUpdateStore.setState({
          installingTag: undefined,
          progress: { stage: "installing", tag: release.tag },
        });
        return;
      }
      useUpdateStore.setState({
        installingTag: undefined,
        progress: { stage: "failed", tag: release.tag, error: result.error },
      });
      setError(result.error);
      if (pin !== previous) await onPinChange?.(previous);
    } catch (e) {
      useUpdateStore.setState({
        installingTag: undefined,
        progress: { stage: "failed", tag: release.tag, error: errorMessage(e) },
      });
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="updates">
      <BuildStatus check={check} checking={checking} error={error} />
      {/* An unsigned Mac has no updater to check automatically. */}
      {bridge.platform !== "darwin" && (
        <Toggle
          label="Check for updates automatically"
          checked={automaticChecks}
          description={copy.automaticChecks}
          disabled={!onPreferencesChange}
          onChange={(value) =>
            void onPreferencesChange?.({ automaticChecks: value }).catch((e: unknown) =>
              setError(errorMessage(e)),
            )
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={checking || busy} onClick={() => void runCheck()}>
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      </div>

      {check && <CheckSummary check={check} />}

      {pinnedVersion && (
        <p className="text-muted-foreground">
          Pinned to {pinnedVersion}: no update notices while it's installed.{" "}
          <button
            type="button"
            className="text-link underline-offset-4 hover:underline"
            onClick={() =>
              void onPinChange?.(null).catch((e: unknown) => setError(errorMessage(e)))
            }
          >
            Unpin
          </button>
        </p>
      )}

      {check?.releases && check.releases.length > 0 && (
        <ul
          aria-label="Releases"
          className="flex flex-col divide-y divide-border rounded-md border border-border"
        >
          {check.releases.map((release) => {
            const action = RELATION_ACTION[release.relation];
            return (
              <li key={release.tag} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                <span className="font-mono">{release.version}</span>
                {release.prerelease && (
                  <span className="rounded-sm border border-border px-1 text-xs text-muted-foreground">
                    pre-release
                  </span>
                )}
                {release.signed && (
                  <span className="rounded-sm border border-border px-1 text-xs text-muted-foreground">
                    signed
                  </span>
                )}
                {release.relation === "current" && (
                  <span className="text-xs text-muted-foreground">running version</span>
                )}
                <span className="ml-auto" />
                {action && check.canSelfInstall && (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy || (check.channel !== undefined && check.channel !== channel)}
                    onClick={() => void install(release)}
                  >
                    {action}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {notesRelease && <ReleaseNotes release={notesRelease} />}

      {check && releasePage && (check.available || error || progress?.stage === "failed") && (
        <p className="text-muted-foreground">
          {check.canSelfInstall
            ? "If the update fails, check again to retry or install manually."
            : "This app location or platform needs a manual update."}{" "}
          <button
            type="button"
            className="text-link underline-offset-4 hover:underline"
            onClick={() => void bridge.openExternal(releasePage)}
          >
            Open the release page
          </button>
        </p>
      )}

      {(error || progress?.stage === "failed") && (
        <p role="alert" className="text-destructive">
          {error ?? progress?.error}
        </p>
      )}
    </div>
  );
}

function CheckSummary({ check }: { check: UpdateCheck }) {
  if (check.noReleaseChannel) {
    return (
      <p className="text-muted-foreground">
        Gram doesn't publish releases yet, so there's no update channel to check.
      </p>
    );
  }
  if (check.unavailable) {
    return (
      <p className="text-muted-foreground">
        {check.unavailableMessage ??
          "Update checks need the GitHub CLI (`gh`) installed and signed in."}
      </p>
    );
  }
  if (!check.available && check.channel === "stable" && check.currentVersion.includes("-")) {
    // An empty stable feed gives the same `available: false`, with nothing to be ahead of.
    const hasStable = check.releases?.some((release) => !release.prerelease) ?? false;
    return (
      <p className="text-muted-foreground">
        You're on pre-release {check.currentVersion}
        {hasStable
          ? ", which is ahead of the latest stable release."
          : ", and there's no stable release yet."}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground">
      {check.available
        ? `Version ${check.latestVersion} is available (you have ${check.currentVersion}).`
        : `No newer verified release is available (you have ${check.currentVersion}).`}
    </p>
  );
}
