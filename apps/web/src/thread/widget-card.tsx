import type { WidgetData } from "@gram/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { Dialog } from "./dialog-shell";
import { readWidgetTheme, svgDataUrl, themedSvg } from "./widget-svg";

/**
 * Theme sync mirrors every preference, the system's light/dark included, onto `<html>` as `data-*`
 * attributes, and an edited custom palette rewrites a `<style>` in the head. Watching both sees each
 * change after its values have landed.
 */
const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
};

/** A stable string, so `useSyncExternalStore` only re-renders when a value actually changed. */
const themeSnapshot = () => JSON.stringify(readWidgetTheme(document.documentElement));

/**
 * A chart or diagram from the `show_widget` app tool. It is an `<img>`, never inline markup: there an
 * SVG is a static image whose scripts don't run and which can't load or link to anything.
 */
export function WidgetCard({ widget }: { widget: WidgetData }) {
  const theme = useSyncExternalStore(subscribeToTheme, themeSnapshot);
  const src = useMemo(
    () => svgDataUrl(themedSvg(widget.svg, JSON.parse(theme) as Record<string, string>)),
    [widget.svg, theme],
  );
  return (
    <figure
      data-testid="widget"
      className="my-2 flex max-w-full flex-col gap-1.5 rounded-md border border-border bg-card p-2"
    >
      <Dialog.Root>
        <Dialog.Trigger
          aria-label={`Open ${widget.title}`}
          className="block cursor-zoom-in self-start rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <img src={src} alt={widget.title} className="max-h-96 max-w-full" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup
            data-testid="widget-full"
            data-surface="overlay"
            className="fixed inset-6 z-50 flex flex-col gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <Dialog.Title className="truncate font-heading text-sm font-medium">
              {widget.title}
            </Dialog.Title>
            <img src={src} alt={widget.title} className="min-h-0 flex-1 object-contain" />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <figcaption className="truncate text-xs text-muted-foreground">{widget.title}</figcaption>
    </figure>
  );
}
