import type { ThreadId } from "@gram/contracts";
import { AppWindow, ArrowUpRight } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { OutboundLink } from "@/panels/outbound-link";
import { useFeature } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";

import type { PublishedArtifact } from "./published-artifacts";

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/**
 * A page the agent published to claude.ai, under the message that published it: Preview renders its
 * local file in the Preview tab (or the Files panel where there is none), and Open on claude.ai takes the
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
  const words = (
    <>
      <span className="line-clamp-2 text-reading font-medium">{name}</span>
      <span className="block truncate text-meta text-muted-foreground">
        Published to claude.ai{artifact.version === undefined ? "" : ` · v${artifact.version}`}
      </span>
    </>
  );
  return (
    // The actions take a row of their own where the card is too narrow to hold them beside the
    // title, as on a phone, so the title is never cut to make room for two buttons.
    <div
      data-testid="artifact-card"
      data-url={artifact.url}
      className="my-2 flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-edge bg-card px-3 py-2"
    >
      <div className="flex min-w-48 flex-1 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <AppWindow aria-hidden className="size-icon-row" />
        </span>
        {show === undefined ? (
          <div className="min-w-0 flex-1" title={artifact.url}>
            {words}
          </div>
        ) : (
          // The title opens the preview too, as a written file's card does.
          <button
            type="button"
            tabIndex={-1}
            className="min-w-0 flex-1 cursor-pointer text-left"
            title={source?.path}
            onClick={show}
          >
            {words}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {show !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Preview ${name}`}
            onClick={show}
          >
            Preview
          </Button>
        )}
        <OutboundLink
          href={artifact.url}
          title={artifact.url}
          className={buttonVariants({
            size: "sm",
            variant: show === undefined ? "outline" : "ghost",
          })}
        >
          Open on claude.ai
          <ArrowUpRight aria-hidden />
        </OutboundLink>
      </div>
    </div>
  );
}
