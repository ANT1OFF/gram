/**
 * The composer's shape, shared by the thread's composer and the `/new` hero's prompt box so the one
 * can move into the other without changing.
 */

/** The slab: the look's radius, a faint outline, a tucked-under shadow and a quiet focus. */
export const SLAB =
  "relative rounded-(--composer-radius) border border-(--composer-outline) bg-card shadow-(--shadow-composer) transition-[border-color,background-color] focus-within:border-(--composer-outline-focus) focus-within:outline-(length:--composer-focus-width) focus-within:outline-ring focus-within:outline-solid data-[dragging=true]:border-primary/70 data-[dragging=true]:bg-accent/45";

/** The message box inside it: grows with its text, to at most a third of a short grid pane. */
export const SLAB_TEXTAREA =
  "block max-h-[min(13rem,calc(var(--pane-height,100vh)*0.33))] min-h-19.5 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none field-sizing-content placeholder:text-muted-foreground";

/**
 * A suggested reply, behind the message box in exactly its box: the typed text invisible, the rest
 * in the placeholder's tone. It wraps and scrolls as the box does.
 */
export const GHOST_MIRROR =
  "pointer-events-none absolute inset-0 overflow-hidden px-4 pt-3 pb-1 text-sm leading-relaxed break-words whitespace-pre-wrap";

/** A toolbar control: no border, muted until hovered. */
export const GHOST_TRIGGER =
  "gap-1.5 border-transparent px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent";

/** Send and Stop: a 32 px circle holding one glyph. */
export const ROUND =
  "grid size-8 shrink-0 place-items-center rounded-(--composer-button-radius) outline-none transition-[opacity,box-shadow,background-color,color] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default";

/** Stop: an outline in the toolbar's tone that only turns to danger under the pointer. */
export const STOP_OUTLINE =
  "border border-(--composer-outline-focus) text-muted-foreground transition-colors hover:border-destructive/50 hover:bg-destructive-tint hover:text-destructive";

/** Queue, while a turn runs: a bare glyph, muted until there is something to queue. */
export const QUEUE_GLYPH =
  "text-foreground transition-colors hover:bg-accent disabled:text-muted-foreground disabled:opacity-50";

/** Send's fill: the accent with a faint gloss, flat while pressed or disabled. */
export const SEND_FILL =
  "bg-primary text-primary-foreground shadow-xs shadow-primary/24 inset-shadow-2xs inset-shadow-white/16 active:inset-shadow-black/8 active:shadow-none disabled:opacity-64 disabled:shadow-none";
