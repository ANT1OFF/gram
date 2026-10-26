import {
  cloneElement,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { Dialog } from "@/thread/dialog-shell";

/** Sidebar facts can include a full stage note. Keep the preview bounded and F1 opens all facts. */
export function SidebarDetails({
  label,
  render,
  children,
  keyboard = true,
}: {
  label: string;
  render: ReactElement<HTMLAttributes<HTMLElement>>;
  children?: ReactNode;
  /** Nested stage marks use their owning row's keyboard disclosure, without another Tab stop. */
  keyboard?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const opener = useOpener(open);
  const body = useRef<HTMLDivElement>(null);
  const trigger = keyboard
    ? cloneElement(render, {
        "aria-keyshortcuts": [render.props["aria-keyshortcuts"], "F1"].filter(Boolean).join(" "),
      })
    : render;
  return (
    <>
      <Tooltip open={!open && hintOpen} onOpenChange={setHintOpen}>
        <TooltipTrigger
          render={trigger}
          onKeyDown={(event) => {
            if (!keyboard || event.target !== event.currentTarget || event.key !== "F1") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent
          side="right"
          className="max-h-[min(24rem,calc(100dvh-2rem))] flex-col items-stretch"
        >
          <span className="min-h-0 overflow-y-auto whitespace-pre-line">{label}</span>
          <span className="shrink-0 border-t border-background/20 pt-1 text-[10px] dark:border-border dark:text-muted-foreground">
            {keyboard ? "Press F1 for full details" : "Focus the row and press F1 for full details"}
          </span>
        </TooltipContent>
      </Tooltip>
      {open && (
        <Dialog.Root open onOpenChange={(value) => setOpen(value)}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
            <Dialog.Popup
              data-testid="sidebar-details"
              data-surface="overlay"
              initialFocus={body}
              finalFocus={returnFocusTo(opener)}
              className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(32rem,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg"
            >
              <Dialog.Title className="shrink-0 font-heading text-base font-medium">
                Sidebar details
              </Dialog.Title>
              <Dialog.Description className="shrink-0 text-xs text-muted-foreground">
                Use Arrow keys, Page Up/Down or Home/End to read all details. Escape returns to the
                row.
              </Dialog.Description>
              <div
                ref={body}
                role="region"
                aria-label="Full sidebar details"
                tabIndex={0}
                className="min-h-0 overflow-y-auto rounded-sm text-xs leading-5 whitespace-pre-line wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
              </div>
              <Button
                className="shrink-0 self-end"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
