import { cn } from "@/lib/utils";
import { useState } from "react";
import { Hint } from "@/components/hint";

import { Dialog } from "./dialog-shell";

/**
 * A thumbnail and the full-size view it opens, for every image the transcript shows: one the user
 * attached, one the agent sent, one a tool call returned. SVG goes through `<img>`, never into the
 * DOM.
 */
export function AttachmentLightbox({
  src,
  name,
  thumbnailClassName = "max-h-48",
  triggerClassName,
  description,
}: {
  src: string;
  name: string;
  /** Bounds the thumbnail; the full-size view always fills the window. */
  thumbnailClassName?: string;
  /** Sizes the thumbnail's button, for a tile that fills its cell. */
  triggerClassName?: string;
  description?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span className="text-xs text-muted-foreground">
        Image preview unavailable: {name} could not be decoded.
      </span>
    );
  return (
    <Dialog.Root>
      <Hint
        label={description ?? `Open ${name} at full size`}
        render={
          <Dialog.Trigger
            data-testid="attachment-thumbnail"
            aria-label={`Open ${name}`}
            className={cn(
              "block cursor-zoom-in overflow-hidden rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              triggerClassName,
            )}
          />
        }
      >
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          className={cn("max-w-full object-contain", thumbnailClassName)}
        />
      </Hint>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid="attachment-lightbox"
          data-surface="overlay"
          className="fixed inset-6 z-50 flex flex-col gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          <Dialog.Title className="truncate font-heading text-sm font-medium">{name}</Dialog.Title>
          <img src={src} alt={name} className="min-h-0 flex-1 object-contain" />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
