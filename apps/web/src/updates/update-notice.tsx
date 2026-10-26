import { ArrowUpCircle, CircleAlert, Clock } from "lucide-react";
import { useEffect } from "react";

import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useServerSettings } from "@/settings-sync/store";

import { decideUpdateNotice } from "./launch-check";
import { useUpdateStore } from "./store";

/**
 * Mount once in the root layout: a dismissible banner announcing a newer release from the latest
 * check. Windows installs on click; elsewhere it links to the release page. A signed Mac's updater has its own
 * pill instead. Nothing happens without a click.
 */
export function UpdateNotice() {
  const bridge = window.gram;
  const latest = useUpdateStore((s) => s.latest);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const channel = useServerSettings((s) => s.settings?.updates.channel ?? "stable");
  const pinned = useServerSettings((s) => s.settings?.updates.pinnedVersion);
  const progress = useUpdateStore((s) => s.progress);
  const installingTag = useUpdateStore((s) => s.installingTag);

  useEffect(
    () => bridge?.updates.onProgress((value) => useUpdateStore.setState({ progress: value })),
    [bridge],
  );

  if (!bridge) return null;
  if (!latest) return null;
  const update = decideUpdateNotice(latest, pinned).announce;
  const offer = update && dismissed !== update.version ? update : undefined;
  const targetTag = progress?.tag ?? installingTag;
  if (!offer && !targetTag) return null;

  const busy =
    installingTag !== undefined || (progress !== undefined && progress.stage !== "failed");
  const displayTag = targetTag ?? offer?.tag;
  const release = latest.releases?.find((r) => r.tag === displayTag);
  const releasePage = release?.htmlUrl ?? (latest.tag === displayTag ? latest.htmlUrl : undefined);
  const differentOffer = offer !== undefined && targetTag !== undefined && offer.tag !== targetTag;
  const stage =
    progress?.stage === "downloading"
      ? "Downloading…"
      : progress?.stage === "verifying"
        ? "Verifying…"
        : progress?.stage === "installing"
          ? "Restarting to install…"
          : "Preparing update request…";
  const install = async () => {
    if (!offer) return;
    useUpdateStore.setState({ installingTag: offer.tag, progress: undefined });
    try {
      const result = await bridge.updates.install({
        channel: latest.channel ?? channel,
        tag: offer.tag,
        downgrade: false,
        ...(latest.installId ? { installId: latest.installId } : {}),
      });
      if (result.updating) {
        useUpdateStore.setState({
          installingTag: undefined,
          progress: { stage: "installing", tag: offer.tag },
        });
        return;
      }
      useUpdateStore.setState({
        installingTag: undefined,
        progress: { stage: "failed", tag: offer.tag, error: result.error },
      });
    } catch (e) {
      useUpdateStore.setState({
        installingTag: undefined,
        progress: { stage: "failed", tag: offer.tag, error: errorMessage(e) },
      });
    }
  };

  return (
    <aside
      aria-label={
        targetTag
          ? progress?.stage === "failed"
            ? "Update failed"
            : "Update in progress"
          : "Update available"
      }
      data-testid="update-notice"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 text-sm text-card-foreground"
    >
      {targetTag ? (
        progress?.stage === "failed" ? (
          <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : (
          <Clock aria-hidden className="size-4 shrink-0 text-primary" />
        )
      ) : (
        <ArrowUpCircle aria-hidden className="size-4 shrink-0 text-primary" />
      )}
      <p className="min-w-0 basis-48 flex-1">
        {targetTag ? (
          <span className="font-medium">
            {progress?.stage === "failed" ? "Update failed" : stage}: {targetTag}
          </span>
        ) : (
          <span className="font-medium">Update available: {offer?.version}</span>
        )}
        <span className="text-muted-foreground">
          {" "}
          · Running {latest.currentVersion}
          {!busy && " · Not installed; no restart pending"}
        </span>
        {differentOffer && (
          <span className="block text-muted-foreground">Available release: {offer.version}</span>
        )}
        {release?.notes && (
          <span className="block text-xs text-muted-foreground wrap-anywhere">
            {release.notes.slice(0, 220)}
            {release.notes.length > 220 ? "…" : ""}
          </span>
        )}
        {progress?.stage === "failed" && (
          <span role="alert" className="block text-destructive">
            {progress.error} Check again to retry, or download and verify the release manually;
            retain your previous app for rollback.
          </span>
        )}
      </p>
      {releasePage && (
        <Button size="sm" variant="ghost" onClick={() => void bridge.openExternal(releasePage)}>
          Release notes
        </Button>
      )}
      {offer && latest.canSelfInstall ? (
        <Button size="sm" disabled={busy} onClick={() => void install()}>
          {differentOffer ? `Update to ${offer.version} and restart` : "Restart to update"}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          useUpdateStore.setState({
            ...(offer ? { dismissed: offer.version } : {}),
            ...(progress?.stage === "failed" ? { progress: undefined } : {}),
          })
        }
      >
        Later
      </Button>
    </aside>
  );
}
