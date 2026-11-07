"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { createContext, useContext, useEffect, useState } from "react";

import { pointerMovedFor, trackPointerMoves } from "@/lib/pointer-moved";
import { cn } from "@/lib/utils";

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

/** A hover open the gate held back, so the trigger's next real movement can ask again. */
interface HeldOpen {
  hold(): void;
  /** Whether a hover open was held back, forgetting it. */
  take(): boolean;
  release(): void;
}

const HeldOpenContext = createContext<HeldOpen | null>(null);

function heldOpen(): HeldOpen {
  let held = false;
  return {
    hold: () => {
      held = true;
    },
    take: () => {
      const was = held;
      held = false;
      return was;
    },
    release: () => {
      held = false;
    },
  };
}

/**
 * A hover opens it only when the pointer moved onto its trigger: a trigger that appears, or moves,
 * under a pointer already resting there stays closed until the pointer moves within it
 * (`pointerMovedFor`), so a panel that opens or a row that folds never pops a hint over the
 * controls beside it. Focus and a moving pointer open it as before.
 */
function Tooltip({ onOpenChange, children, ...props }: TooltipPrimitive.Root.Props) {
  useEffect(trackPointerMoves, []);
  const [held] = useState(heldOpen);
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      onOpenChange={(open, details) => {
        if (open && details.reason === "trigger-hover" && !pointerMovedFor(details.event)) {
          held.hold();
          details.cancel();
          return;
        }
        held.release();
        onOpenChange?.(open, details);
      }}
      {...props}
    >
      {typeof children === "function" ? (
        (payload) => (
          <HeldOpenContext.Provider value={held}>{children(payload)}</HeldOpenContext.Provider>
        )
      ) : (
        <HeldOpenContext.Provider value={held}>{children}</HeldOpenContext.Provider>
      )}
    </TooltipPrimitive.Root>
  );
}

function TooltipTrigger({ onMouseMove, onMouseLeave, ...props }: TooltipPrimitive.Trigger.Props) {
  const held = useContext(HeldOpenContext);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      // The hover hook opens on entering only; once the pointer really moves over a trigger whose
      // hover the gate held back, it enters again, as the user's own move.
      onMouseMove={(event) => {
        onMouseMove?.(event);
        if (held === null) return;
        if (!pointerMovedFor(event.nativeEvent, event.currentTarget) || !held.take()) return;
        event.currentTarget.dispatchEvent(
          new MouseEvent("mouseenter", { clientX: event.clientX, clientY: event.clientY }),
        );
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        held?.release();
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) wrap-anywhere items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-meta text-background dark:border dark:border-border dark:bg-popover dark:text-popover-foreground dark:shadow-overlay dark:[&_kbd]:text-popover-foreground [&_code]:bg-current/15 has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[instant]:transition-none data-[starting-style]:scale-98 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-2xs bg-foreground fill-foreground dark:bg-popover dark:fill-popover data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
