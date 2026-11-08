/**
 * The composer's shape, shared by the thread's composer and the `/new` hero's prompt box so the one
 * can move into the other without changing.
 */

/** The slab: the look's radius, a faint outline, a tucked-under shadow and a quiet focus. */
export const SLAB =
  "relative rounded-(--composer-radius) border border-(--composer-outline) bg-card shadow-(--shadow-composer) transition-[border-color,background-color] focus-within:border-(--composer-outline-focus) focus-within:outline-(length:--composer-focus-width) focus-within:outline-ring focus-within:outline-solid data-[dragging=true]:border-primary/70 data-[dragging=true]:bg-accent/45";

/** The message box inside it: grows with its text, to at most a third of a short grid pane. */
export const SLAB_TEXTAREA =
  "block max-h-[min(13rem,calc(var(--pane-height,100vh)*0.33))] min-h-19.5 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-reading leading-relaxed outline-none field-sizing-content placeholder:text-muted-foreground";

/**
 * A suggested reply, behind the message box in exactly its box: the typed text invisible, the rest
 * in the placeholder's tone. It wraps and scrolls as the box does.
 */
export const GHOST_MIRROR =
  "pointer-events-none absolute inset-0 overflow-hidden px-4 pt-3 pb-1 text-reading leading-relaxed break-words whitespace-pre-wrap";

/**
 * On a phone, a toolbar control's hit area grows to 44 px past its 32 px look, so a thumb finds it
 * without the row growing.
 */
export const PHONE_HIT =
  "max-sm:relative max-sm:after:absolute max-sm:after:-inset-1.5 max-sm:after:content-['']";

/**
 * A toolbar control: no border, muted until hovered, and as tall as Send (32 px) so every target on
 * the row is the same size, at least as wide as it is tall.
 */
export const GHOST_TRIGGER = `h-8 min-w-8 gap-1.5 border-transparent px-2 text-meta font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:focus-ring data-[size=sm]:h-8 data-[popup-open]:bg-accent dark:hover:bg-accent ${PHONE_HIT}`;

/** Send and Stop: a 32 px circle holding one glyph, 44 px on a phone. */
export const ROUND =
  "grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-(--composer-button-radius) outline-none transition-[opacity,box-shadow,background-color,color] focus-visible:focus-ring disabled:cursor-default";

/**
 * Stop's fill while a turn runs, on `ROUND`: solid in the text colour, so it reads as a stop button
 * and never as Send's accent, its square inside a turning ring (drawn by the composer) that says
 * the agent is at work. Send's size, in Send's place, so the spot doesn't move; no word and no key
 * cap, as both are in its tooltip. Danger only under the pointer.
 */
export const STOP_FILL = "bg-foreground text-background hover:bg-destructive";

/**
 * Stop's fill while the turn only waits on the user, at an approval or a question: the answer on
 * its card is the step to take, so Stop steps back from the solid fill, with no turning ring, as
 * nothing runs. It keeps a tint of its own, the danger tint a destructive button takes, so it still
 * reads as Stop at a glance and never as a faint outline.
 */
export const STOP_QUIET =
  "bg-destructive-tint text-destructive hover:bg-destructive-tint-hover";

/**
 * Send's fill: the accent with a faint gloss, flat while pressed. With nothing to send it takes the
 * neutral disabled fill every button takes (components/ui/button.tsx), never a dimmed accent that
 * still reads as pressable.
 */
export const SEND_FILL =
  "bg-primary text-primary-foreground shadow-raised shadow-primary/24 inset-shadow-2xs inset-shadow-white/16 active:inset-shadow-black/8 active:shadow-none disabled:bg-muted disabled:text-subtle disabled:shadow-none disabled:inset-shadow-none disabled:ring-1 disabled:ring-border";
