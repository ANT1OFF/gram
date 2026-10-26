import { loopbackUrl, type ThreadId } from "@gram/contracts";
import { Globe, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { askToOpen } from "@/links/link-dialog";
import { useLayoutStore } from "@/stores/layout";

/**
 * The agent's suggested local preview for `threadId`, where there is no Preview tab (a browser, or
 * a shell older than it); the URL opens externally only on click.
 */
export function PreviewSuggestionNotice({ threadId }: { threadId: ThreadId | undefined }) {
  const suggestion = useLayoutStore((s) => s.previewSuggestion);
  const dismiss = useLayoutStore((s) => s.dismissPreview);
  if (!suggestion || suggestion.threadId !== threadId) return null;
  const { url } = suggestion;

  const open = () => {
    if (!loopbackUrl(url)) return;
    const bridge = window.gram;
    if (bridge?.openExternal) void bridge.openExternal(url);
    else {
      void askToOpen(url).then((allowed) => {
        if (allowed) window.open(url, "_blank", "noopener");
      });
    }
  };

  return (
    <div
      role="status"
      data-testid="preview-suggestion"
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Globe aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={url}>
        Agent suggests previewing <span className="font-mono text-foreground">{url}</span>
      </span>
      <Button type="button" size="xs" variant="ghost" onClick={open}>
        Open
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss preview suggestion"
        onClick={dismiss}
      >
        <X />
      </Button>
    </div>
  );
}
