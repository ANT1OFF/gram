import type { AppBuildInfo, ReleaseInfo, UpdateCheck } from "@gram/contracts";
import { Info } from "lucide-react";
import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useUpdateStore } from "./store";

const PROVENANCE_NOTE =
  "Merged changes become available only in a published release. They take effect after you install that release and restart Gram.";

export function BuildStatus({
  check,
  checking,
  error,
}: {
  check: UpdateCheck | undefined;
  checking: boolean;
  error: string | undefined;
}) {
  const [build, setBuild] = useState<AppBuildInfo>();
  const progress = useUpdateStore((s) => s.progress);
  const installingTag = useUpdateStore((s) => s.installingTag);
  useEffect(() => {
    let live = true;
    window.gram?.appBuildInfo?.().then(
      (info) => {
        if (live) setBuild(info);
      },
      () => {}, // Older/unavailable shells still show the version supplied by the updater.
    );
    return () => {
      live = false;
    };
  }, []);

  const active = progress && progress.stage !== "failed";
  const status = active
    ? progress.stage === "downloading"
      ? "Downloading update"
      : progress.stage === "verifying"
        ? "Verifying update"
        : "Restarting to install"
    : installingTag
      ? "Preparing update request"
      : checking
        ? "Checking releases"
        : error || progress?.stage === "failed" || check?.unavailable
          ? "Update error"
          : check?.available
            ? "Update available"
            : check
              ? "Current for checked channel"
              : "Not checked yet";
  const version = build?.version ?? check?.currentVersion;
  const latest = check?.releases?.[0]?.version ?? check?.latestVersion;
  return (
    <div className="rounded-md border border-border bg-card p-3" data-testid="build-status">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Running Gram {version ?? "· version unavailable"}</p>
        <Tooltip>
          <TooltipTrigger
            aria-label="About running and released changes"
            className="rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Info aria-hidden className="size-4" />
          </TooltipTrigger>
          <TooltipContent role="tooltip">{PROVENANCE_NOTE}</TooltipContent>
        </Tooltip>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {build?.packaged === false
          ? "Development build · source identity unavailable"
          : build?.sourceCommit
            ? `Source ${build.sourceCommit.slice(0, 8)}`
            : "Source identity unavailable in this build"}
      </p>
      <p role="status" className="mt-2 font-medium">
        {status}
      </p>
      {!active && !installingTag && (
        <p className="text-muted-foreground">No download or restart pending.</p>
      )}
      {(active || installingTag) && (
        <p className="text-muted-foreground">
          {progress?.tag ?? installingTag} · The running version changes only after installation and
          restart.
        </p>
      )}
      {check?.channel && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last checked: {check.channel === "prerelease" ? "Pre-release" : "Stable"}
          {check.checkedAt !== undefined && Number.isFinite(check.checkedAt) && (
            <>
              {" "}
              ·{" "}
              <time dateTime={new Date(check.checkedAt).toISOString()}>
                {new Date(check.checkedAt).toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                })}
              </time>
            </>
          )}
          {!check.unavailable && latest && <> · Latest release {latest}</>}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{PROVENANCE_NOTE}</p>
    </div>
  );
}

/** Plain text from this exact release, never the static development What's New history. */
export function ReleaseNotes({ release }: { release: ReleaseInfo }) {
  const excerpt = release.notes?.slice(0, 600);
  return (
    <div className="rounded-md border border-border p-3" data-testid="release-notes">
      <p className="font-medium">Release notes · {release.version}</p>
      {release.sourceCommit && (
        <p className="text-xs text-muted-foreground">
          Release source {release.sourceCommit.slice(0, 8)}
        </p>
      )}
      <p className="mt-1 whitespace-pre-line wrap-anywhere text-muted-foreground">
        {excerpt
          ? `${excerpt}${release.notes!.length > 600 ? "…" : ""}`
          : "No release notes were supplied by this update check."}
      </p>
      {release.htmlUrl && (
        <button
          type="button"
          className="mt-1 text-link underline-offset-4 hover:underline"
          onClick={() => void window.gram?.openExternal(release.htmlUrl!)}
        >
          Read full release notes
        </button>
      )}
    </div>
  );
}
