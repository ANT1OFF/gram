import { LayoutGroup, type HTMLMotionProps } from "motion/react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";

import { useMotionLevel, usePresetTransition } from "./hooks";

/** Scopes `GlideItem` ids so items glide between lists (e.g. sidebar status groups). */
export function GlideList({ id, children }: { id?: string; children: ReactNode }) {
  return <LayoutGroup {...(id ? { id } : {})}>{children}</LayoutGroup>;
}

type GlideItemProps = Omit<HTMLMotionProps<"li">, "layout" | "layoutId"> & {
  /** Stable across lists: an item rendered under a new parent glides from its old position. */
  glideId: string;
};

/** A list item that glides to its new position with the look's gentle preset. */
export function GlideItem({ glideId, transition, ...props }: GlideItemProps) {
  const gentle = usePresetTransition("gentle");
  return <m.li layout="position" layoutId={glideId} transition={transition ?? gentle} {...props} />;
}

/**
 * Text that glides from where the same `glideId` was last shown, such as a name in a list into the
 * header of the view it opens. Without an id, or with motion off, it is plain text.
 */
export function GlideText({
  glideId,
  className,
  children,
}: {
  glideId: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  const gentle = usePresetTransition("gentle");
  const level = useMotionLevel();
  if (glideId === undefined || level === "off")
    return <span className={className}>{children}</span>;
  return (
    <m.span layout="position" layoutId={glideId} transition={gentle} className={className}>
      {children}
    </m.span>
  );
}
