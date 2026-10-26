import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";

import { ThemeRoot } from "@/components/theme-root";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NeedsYouSource } from "@/orchestration/use-needs-you";
import { AppOverlays } from "@/shell/app-overlays";
import { AppShell } from "@/shell/app-shell";
import { usePreloadAfterPaint } from "@/shell/preload-after-paint";
import { useAppLifecycle } from "@/shell/use-app-lifecycle";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  useAppLifecycle();
  usePreloadAfterPaint();

  return (
    <ThemeRoot>
      <TooltipProvider>
        <NeedsYouSource />
        <AppShell />
        <AppOverlays />
      </TooltipProvider>
    </ThemeRoot>
  );
}
