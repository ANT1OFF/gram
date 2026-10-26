import { AlertCircle, Paperclip, X } from "lucide-react";
import { AnimatePresence, useIsPresent, type HTMLMotionProps } from "motion/react";
import * as m from "motion/react-m";

import { cn } from "@/lib/utils";
import { Spinner, useArrivals, useMotionLevel, usePresetTransition } from "@/motion";

import type { PendingAttachment } from "./attachments";

const REMOVE =
  "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none";

/**
 * A composer's pasted and dropped files: an image as a 64 px thumbnail, anything else as a named
 * chip, each with its upload spinner, error and remove button.
 */
export function AttachmentChips({
  items,
  onRemove,
  className,
}: {
  items: readonly PendingAttachment[];
  onRemove: (key: string) => void;
  className?: string;
}) {
  // A file just pasted or dropped settles in; a restored draft's files are simply there.
  const arrivals = useArrivals(
    items.map((item) => item.key),
    true,
  );
  const level = useMotionLevel();
  const snappy = usePresetTransition("snappy");
  if (items.length === 0) return null;
  // A removed chip shrinks and fades out of the flow, and the chips after it glide into its place.
  // Under Reduced and Off it goes at once: popped out of the flow while it faded, it would sit over
  // the chip that took its place. The last one goes with the row, which the composer folds anyway.
  const chip =
    level === "full"
      ? { layout: "position" as const, exit: { opacity: 0, scale: 0.8 }, transition: snappy }
      : {};
  return (
    <ul
      aria-label="Attachments"
      className={cn("relative flex flex-wrap items-end gap-1.5", className)}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((item) => {
          const failed = item.status === "failed";
          const common = {
            "data-testid": "attachment-chip",
            "data-status": item.status,
            title: item.error ?? item.attachment?.path ?? item.name,
          };
          const remove = (
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              className={cn(
                REMOVE,
                item.previewUrl
                  ? "absolute top-1 right-1 grid size-5 place-items-center bg-black/60 text-white hover:bg-black/75"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onRemove(item.key)}
            >
              <X className="size-3" />
            </button>
          );
          return item.previewUrl ? (
            <ChipItem
              key={item.key}
              {...chip}
              {...common}
              className={cn(
                "relative size-16 overflow-hidden rounded-(--radius-md) border bg-muted",
                arrivals.has(item.key) && "gram-swap",
                failed ? "border-destructive" : "border-border",
              )}
            >
              <img
                src={item.previewUrl}
                alt={item.name}
                className={cn("size-full object-cover", failed && "opacity-40")}
              />
              {item.status === "uploading" && (
                <span className="absolute inset-0 grid place-items-center bg-background/50">
                  <Spinner aria-label="Uploading" className="size-4" />
                </span>
              )}
              {failed && (
                <AlertCircle
                  aria-label="Failed"
                  className="absolute bottom-1 left-1 size-4 rounded-full bg-card text-destructive"
                />
              )}
              {remove}
            </ChipItem>
          ) : (
            <ChipItem
              key={item.key}
              {...chip}
              {...common}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs",
                arrivals.has(item.key) && "gram-swap",
                failed ? "border-destructive text-destructive" : "border-border",
              )}
            >
              <Paperclip aria-hidden className="size-3" />
              {item.name}
              {item.status === "uploading" && <Spinner aria-label="Uploading" className="size-3" />}
              {remove}
            </ChipItem>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

/**
 * One chip, inert while it leaves: popped out of the flow, it still covers the place the next chip
 * is gliding into, and a click meant for that one must not remove this one again.
 */
function ChipItem(props: HTMLMotionProps<"li">) {
  const present = useIsPresent();
  return <m.li {...props} inert={!present} />;
}
