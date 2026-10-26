import type { ThreadId } from "@gram/contracts";
import { AppWindow } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { OutboundLink } from "@/panels/outbound-link";
import { useFeature } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";

import type { PublishedArtifact } from "./published-artifacts";

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/**
 * A page the agent published to claude.ai, under the message that published it: Show renders its
 * local file in the Preview tab (or the Files panel where there is none), and Open takes the
 * claude.ai page, where it can be shared and commented on, to the browser.
 */
export function ArtifactCard({
  threadId,
  artifact,
}: {
  threadId: ThreadId;
  artifact: PublishedArtifact;
}) {
  const previewPane = useFeature("previewPane");
  const previewFile = useLayoutStore((s) => s.previewFile);
  const { source } = artifact;
  const name = artifact.title ?? (source === undefined ? "Artifact" : nameOf(source.path));
  const show =
    source === undefined ? undefined : () => previewFile(threadId, source.path, { previewPane });
  return (
    <div
      data-testid="artifact-card"
      data-url={artifact.url}
      className="my-2 flex max-w-md items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <AppWindow aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1" title={artifact.url}>
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          Artifact on claude.ai{artifact.version === undefined ? "" : ` · v${artifact.version}`}
        </span>
      </div>
      {show !== undefined && (
        <Button type="button" size="sm" variant="ghost" aria-label={`Show ${name}`} onClick={show}>
          Show
        </Button>
      )}
      <OutboundLink
        href={artifact.url}
        title={artifact.url}
        className={buttonVariants({ size: "sm", variant: "outline" })}
      >
        Open
      </OutboundLink>
    </div>
  );
}
