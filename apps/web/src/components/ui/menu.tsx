import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { MENU_DANGER, MENU_FITS, MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";

const Menu = MenuPrimitive.Root;

const MenuTrigger = MenuPrimitive.Trigger;

const MenuGroup = MenuPrimitive.Group;

const MenuRadioGroup = MenuPrimitive.RadioGroup;

const MenuSub = MenuPrimitive.SubmenuRoot;

function MenuContent({
  className,
  side = "bottom",
  align = "end",
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"];
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: number;
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          data-surface="overlay"
          className={cn(MENU_POPUP, MENU_FITS, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuItem({
  className,
  danger = false,
  ...props
}: MenuPrimitive.Item.Props & { danger?: boolean }) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(MENU_ITEM, danger && MENU_DANGER, className)}
      {...props}
    />
  );
}

const INDICATOR = "flex size-3.5 shrink-0 items-center justify-center";

function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="menu-checkbox-item"
      closeOnClick={false}
      className={cn(MENU_ITEM, className)}
      {...props}
    >
      <span className={INDICATOR}>
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon aria-hidden />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      closeOnClick
      className={cn(MENU_ITEM, className)}
      {...props}
    >
      <span className={INDICATOR}>
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon aria-hidden />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function MenuSubTrigger({ className, children, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="menu-sub-trigger"
      className={cn(MENU_ITEM, "data-[popup-open]:bg-accent", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon aria-hidden className="ml-auto size-icon-chip!" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side="right" alignOffset={-4} className="isolate z-50 outline-none">
        <MenuPrimitive.Popup
          data-slot="menu-sub-content"
          data-surface="overlay"
          className={cn(MENU_POPUP, MENU_FITS, className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
};
