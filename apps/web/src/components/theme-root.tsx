import { useLayoutEffect, type ReactNode } from "react";

import { MotionRoot } from "@/motion/root";
import { startFontOverrides } from "@/theme/font-overrides";
import { themeStore, useThemeStore } from "@/theme/store";
import { startThemeSync, syncCustomPaletteStyle } from "@/theme/sync";
import { systemSource } from "@/theme/system";

/**
 * Mirrors theme preferences and font overrides onto `<html>` and configures Motion for the motion
 * setting.
 */
export function ThemeRoot({ children }: { children: ReactNode }) {
  const customPalettes = useThemeStore((s) => s.customPalettes);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const stop = startThemeSync(themeStore, systemSource, root);
    // index.html boots with transitions off; keep them off until the synced theme has painted, so
    // nothing animates from the boot attributes into it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => root.removeAttribute("data-theme-booting"));
    });
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, []);
  useLayoutEffect(() => startFontOverrides(document.documentElement), []);
  useLayoutEffect(() => syncCustomPaletteStyle(document, customPalettes), [customPalettes]);

  return <MotionRoot>{children}</MotionRoot>;
}
