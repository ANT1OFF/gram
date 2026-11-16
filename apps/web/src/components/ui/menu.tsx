import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { MENU_DANGER, MENU_FITS, MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";

/**
 * A menu hung from a button: the ⋯ at a row's end, a chip's choices. The popup and rows are the
 * ones Gram's own menus draw (`MENU_POPUP`, `MENU_ITEM`): the row cursor where the pointer or the
 * arrow keys are, a 16 px glyph before a row's words. Esc, a pick or a click outside closes it and
 * gives focus back to the trigger.
 *
 * ```tsx
 * <Menu>
 *   <MenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label="Member actions" />}>
 *     <Ellipsis aria-hidden />
 *   </MenuTrigger>
 *   <MenuContent>
 *     <MenuItem onClick={rename}>Rename</MenuItem>
 *     <MenuSeparator />
 *     <MenuItem danger onClick={remove}>Remove</MenuItem>
 *   </MenuContent>
 * </Menu>
 * ```
 */
const Menu = MenuPrimitive.Root;

/** What opens the menu; give it a `render` (a `Button`) for Gram's look. */
const MenuTrigger = MenuPrimitive.Trigger;

/** A group of rows, named by its `MenuLabel` for a screen reader. */
const MenuGroup = MenuPrimitive.Group;

/** Rows of which one is picked; give it `value` and `onValueChange`. */
const MenuRadioGroup = MenuPrimitive.RadioGroup;

/** A submenu: its `MenuSubTrigger` row and its own `MenuSubContent`. */
const MenuSub = MenuPrimitive.SubmenuRoot;

/**
 * The menu's popup, under its trigger by default and lined up with its end edge. `side`, `align`
 * and `sideOffset` place it; every other prop goes to the popup. It never runs past the window: a
 * long menu scrolls and a long row wraps.
 */
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

/** One row; `onClick` is its action. `danger` for one that removes something. */
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

/** The tick a checked row shows; it keeps its width unchecked so the rows' words line up. */
const INDICATOR = "flex size-3.5 shrink-0 items-center justify-center";

/** A setting toggled from the menu. The menu stays open, so several can be changed in one visit. */
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

/** One of a `MenuRadioGroup`'s rows, ticked while it is the group's value. A pick closes the menu. */
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

/** A group's heading, small and muted, over its rows. */
function MenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

/** A hairline between groups of rows. */
function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

/** A row that opens its submenu, with the chevron at its end. */
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

/** A submenu's popup, beside its row. */
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
