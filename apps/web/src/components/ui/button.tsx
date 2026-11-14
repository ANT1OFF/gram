import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";

/**
 * One disabled look for every button: never a faded copy of its enabled fill, which reads as live
 * (a dim accent still looks pressable). A filled button turns to the neutral raised fill with
 * its words dimmed, an outlined one keeps its edge on no fill, and a quiet one dims its words.
 * The words take the disabled colour, a step under subtle text: subtle text on a light page read
 * as a live quiet button.
 */
const DISABLED_FILL =
  "disabled:border-border disabled:bg-muted data-disabled:border-border data-disabled:bg-muted";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-body font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:focus-ring motion-safe:active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:text-disabled disabled:shadow-none data-disabled:text-disabled aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-icon-row",
  {
    variants: {
      variant: {
        default: `bg-primary text-primary-foreground hover:bg-primary/80 ${DISABLED_FILL}`,
        outline:
          "border-border bg-background text-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-transparent dark:hover:bg-muted disabled:bg-transparent data-disabled:bg-transparent",
        secondary: `bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--surface-fill),var(--fg)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground ${DISABLED_FILL}`,
        // The row hover's fill (surface-hover), so an icon button shows its 28 px target in dark too.
        ghost:
          "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
        destructive: `bg-destructive-tint text-destructive hover:bg-destructive-tint-hover ${DISABLED_FILL}`,
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        // On a phone every worded button is a finger's 44 px, whatever its desktop size.
        default:
          "h-8 gap-1.5 px-2.5 phone:h-11 phone:px-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-meta in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-icon-row",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-body phone:h-11 phone:px-4 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-icon-row",
        lg: "h-9 gap-1.5 px-2.5 phone:h-11 phone:px-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        // Every icon button is at least 28 px square. `icon-xs` holds a row's glyph (16 px), for
        // rows, cards and docks; `icon-sm` holds a toolbar's glyph (18 px), for the title bar, the
        // sidebar's header and the composer's toolbar (DESIGN.md, Icons).
        "icon-xs":
          "size-7 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-icon-row",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-icon-bar",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * An icon button's `title` is its tooltip, shown at once rather than after the native title's
 * second: a glyph alone needs its name the moment it is hovered or focused.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  title,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  const tip = size?.startsWith("icon") === true && typeof title === "string" && title !== "";
  const button = (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      title={tip ? undefined : title}
      {...props}
    />
  );
  return tip ? <Hint label={title} render={button} /> : button;
}

export { Button, buttonVariants };
