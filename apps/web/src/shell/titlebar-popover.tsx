import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Expand, useMotionLevel } from "@/motion";

/**
 * A title bar control's popover: anchored under its trigger at the right, unfolding with `Expand`
 * when it opens. `onShown` runs once the content is out of its fold and can take focus.
 */
export function TitlebarPopover({
  trigger,
  label,
  testId,
  className,
  onShown,
  align = "end",
  open: openProp,
  onOpenChange,
  children,
}: {
  /** The button that opens it, with its own name, classes and test id. */
  trigger: ReactElement;
  /** The popup's accessible name. */
  label: string;
  testId?: string;
  className?: string;
  onShown?: (popup: HTMLElement) => void;
  /** Which edge of the trigger it lines up with: `start` for a control at the title bar's left. */
  align?: "start" | "end";
  /** For a caller that closes it itself; uncontrolled otherwise. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={align} sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            aria-label={label}
            data-testid={testId}
            // The unfold below moves focus in itself, once the content is no longer inert.
            initialFocus={false}
            className="outline-none"
          >
            <Unfold onShown={onShown}>
              <div
                className={cn(
                  "rounded-md border border-border bg-popover text-popover-foreground shadow-md",
                  className,
                )}
              >
                {children}
              </div>
            </Unfold>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Mounts folded and unfolds a frame later, so `Expand` has a height to grow from. */
function Unfold({
  onShown,
  children,
}: {
  onShown: ((popup: HTMLElement) => void) | undefined;
  children: ReactNode;
}) {
  const animated = useMotionLevel() === "full";
  const [shown, setShown] = useState(!animated);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  const told = useRef(false);
  useEffect(() => {
    if (!shown || told.current || ref.current === null) return;
    told.current = true;
    onShown?.(ref.current);
  }, [shown, onShown]);
  return (
    <div ref={ref}>
      <Expand open={shown}>{children}</Expand>
    </div>
  );
}
