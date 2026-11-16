import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { MENU_DANGER, MENU_FITS, MENU_ITEM, MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuSub = ContextMenuPrimitive.SubmenuRoot;

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      className={cn("select-none", className)}
      {...props}
    />
  );
}

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          data-surface="overlay"
          className={cn(MENU_POPUP, MENU_FITS, className)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

/** One row; `onClick` is its action. `danger` for one that removes something. */
function ContextMenuItem({
  className,
  danger = false,
  ...props
}: ContextMenuPrimitive.Item.Props & { danger?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(MENU_ITEM, danger && MENU_DANGER, className)}
      {...props}
    />
  );
}

/** The tick a checked checkbox or radio item shows; it keeps its width unchecked so labels line up. */
const INDICATOR = "flex size-3.5 shrink-0 items-center justify-center";

/** A setting toggled from the menu. The menu stays open, so several can be changed in one visit. */
function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      closeOnClick={false}
      className={cn(MENU_ITEM, className)}
      {...props}
    >
      <span className={INDICATOR}>
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon aria-hidden className="size-icon-row" />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: ContextMenuPrimitive.RadioItem.Props) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      closeOnClick={false}
      className={cn(MENU_ITEM, className)}
      {...props}
    >
      <span className={INDICATOR}>
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden className="size-icon-row" />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

function ContextMenuSeparator({ className, ...props }: ContextMenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      className={cn(MENU_ITEM, "data-[popup-open]:bg-accent", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon aria-hidden className="ml-auto size-icon-chip!" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

function ContextMenuSubContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        side="right"
        alignOffset={-4}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-sub-content"
          data-surface="overlay"
          className={cn(MENU_POPUP, MENU_FITS, className)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
