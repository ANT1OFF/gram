// One selection and focus style, everywhere: the utilities and tokens behind these are in
// styles/globals.css and styles/tokens.css, and DESIGN.md says where each goes.

/** Keyboard focus on a control: the focus-ring token outside it, nothing for a pointer. */
export const FOCUS_RING = "outline-none focus-visible:focus-ring";

/** Keyboard focus on a row or a card in a list, drawn inside it so neighbours don't clip it. */
export const FOCUS_RING_INSET = "outline-none focus-visible:focus-ring-inset";

/**
 * A menu's popup. It takes focus as it opens, but its rows show where the keyboard is: the popup
 * itself never rings.
 */
export const MENU_POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0";

/** A menu's row: the row cursor where the pointer or the arrow keys are. */
export const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:row-cursor [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A menu's group heading. */
export const MENU_LABEL = "px-2 pt-1.5 pb-0.5 text-caption font-medium text-muted-foreground";

/**
 * A choice card in a radio group (New's Who does it, autonomy, the first run's repositories): muted
 * until picked; picked, the accent-tinted fill and edge, with a check (`ChoiceCheck`) beside its
 * title, so the pick never shows by colour alone.
 */
export const CHOICE_CARD =
  "relative flex flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring-inset disabled:cursor-not-allowed disabled:opacity-50 aria-checked:text-foreground";
