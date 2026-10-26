import * as m from "motion/react-m";

import { cn } from "@/lib/utils";

import { usePresetTransition } from "./hooks";

/**
 * The selected segment's background, rendered inside whichever segment is selected. When the
 * selection moves, it slides across from the old segment by transform with the look's snappy
 * preset (Motion's `layoutId`, after animate-ui's highlight); Reduced and Off strip layout
 * animation, so it simply appears under the new one. `group` must be unique to the control on
 * screen, so a `useId`: two panes showing the same control must not trade slabs. The segment needs
 * `relative` and the control `isolate`, so the slab sits under every segment's label as it passes.
 */
export function SegmentSlab({ group, className }: { group: string; className?: string }) {
  const snappy = usePresetTransition("snappy");
  return (
    <m.span
      aria-hidden
      layoutId={`segment-slab-${group}`}
      transition={snappy}
      data-testid="segment-slab"
      className={cn("gram-segment-slab absolute inset-0 -z-10 rounded-[inherit]", className)}
    />
  );
}
