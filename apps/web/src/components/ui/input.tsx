import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A one-line text field's look, as Settings' typed fields have it: 32 px tall, the input border
 * and the focus ring.
 */
export const inputCls =
  "h-8 w-full max-w-md rounded-lg border border-input bg-transparent px-2.5 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** `Input`'s own states: dimmed while disabled, the destructive edge while marked invalid. */
const INPUT_STATES =
  "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30";

/** A one-line text field. `invalid` marks it for a screen reader and draws its edge in red. */
export function Input({
  className,
  invalid,
  ...props
}: ComponentProps<"input"> & { invalid?: boolean | undefined }) {
  return (
    <input
      data-slot="input"
      {...(invalid ? { "aria-invalid": true } : {})}
      className={cn(inputCls, INPUT_STATES, className)}
      {...props}
    />
  );
}

/**
 * A field with its unit: words ahead of the input ("$") or after it ("per month"), muted, on the
 * input's line. The words are decoration; name the unit in the field's label or description too.
 */
export function InputGroup({
  prefix,
  suffix,
  className,
  children,
}: {
  prefix?: ReactNode;
  suffix?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span data-slot="input-group" className={cn("flex items-center gap-1", className)}>
      {prefix !== undefined && (
        <span aria-hidden className="text-muted-foreground">
          {prefix}
        </span>
      )}
      {children}
      {suffix !== undefined && (
        <span aria-hidden className="text-meta text-muted-foreground">
          {suffix}
        </span>
      )}
    </span>
  );
}
