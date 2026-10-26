import { LOOKS, type MotionPersonality } from "@gram/themes";
import type { Transition } from "motion/react";

import { useThemeStore } from "@/theme/store";
import { useSystemPrefs } from "@/theme/system";
import { resolveMotion, type ResolvedMotion } from "@/theme/theme";

import { toTransition } from "./transitions";

export function useMotionLevel(): ResolvedMotion {
  const pref = useThemeStore((s) => s.motion);
  const { prefersReducedMotion } = useSystemPrefs();
  return resolveMotion(pref, prefersReducedMotion);
}

export function useLookMotion(): MotionPersonality {
  return LOOKS[useThemeStore((s) => s.look)].motion;
}

/** The current look's `snappy` / `gentle` / `bouncy` preset as a Motion transition. */
export function usePresetTransition(kind: keyof MotionPersonality["springs"]): Transition {
  return toTransition(useLookMotion().springs[kind], useMotionLevel());
}
