/*
 * The check is redrawn after line-md's `confirm` (MIT, Copyright 2020 Vjacheslav Trushkin; notice in
 * `THIRD-PARTY-NOTICES.md` beside this file). Its SMIL animation isn't used: the draw is one CSS
 * animation that plays as the mark mounts.
 */
import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A check mark that draws itself once as it mounts: a copy button turning into "Copied". Mounted
 * only when the copy happens, so a list of them never draws at once. Reduced fades it in and Off
 * shows it whole. Also takes Streamdown's icon props, so it can stand in for its `CheckIcon`.
 */
export function DrawnCheck({
  className,
  size,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number | undefined }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(size === undefined ? {} : { width: size, height: size })}
      {...props}
      data-testid="drawn-check"
      className={cn(size === undefined && "size-4", className)}
    >
      <path className="gram-draw" d="M5 12.5l4.5 4.5l9.5 -10" pathLength={1} />
    </svg>
  );
}
