import type { Easing, MotionPreset } from "@gram/themes";
import type { Transition } from "motion/react";

import type { ResolvedMotion } from "@/theme/theme";

/** A JS equivalent of CSS `steps()`. */
export function stepsEasing(
  count: number,
  position: Extract<Easing, { type: "steps" }>["position"],
) {
  return (t: number) => {
    if (t >= 1) return 1;
    if (t <= 0)
      return position === "start" || position === "jump-both"
        ? 1 / (count + (position === "jump-both" ? 1 : 0))
        : 0;
    switch (position) {
      case "start":
        return Math.ceil(t * count) / count;
      case "jump-none":
        return Math.min(Math.floor(t * count), count - 1) / (count - 1);
      case "jump-both":
        return (Math.floor(t * count) + 1) / (count + 1);
      default:
        return Math.floor(t * count) / count;
    }
  };
}

export function toEase(easing: Easing): [number, number, number, number] | ((t: number) => number) {
  return easing.type === "bezier" ? [...easing.points] : stepsEasing(easing.count, easing.position);
}

/**
 * A Motion transition for a look's preset under the motion setting. Off is instant; Reduced keeps
 * the preset (MotionConfig already strips transform and layout animation, leaving fades).
 */
export function toTransition(preset: MotionPreset, level: ResolvedMotion): Transition {
  if (level === "off") return { duration: 0 };
  if (preset.type === "spring") {
    return {
      type: "spring",
      stiffness: preset.stiffness,
      damping: preset.damping,
      mass: preset.mass,
    };
  }
  return { type: "tween", duration: preset.duration / 1000, ease: toEase(preset.easing) };
}
