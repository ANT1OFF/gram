import { localPortUrl, type ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import type { Api } from "@/api/types";
import { isMac } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { useFeature } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";

/** Opens a local port in the default browser: through the desktop bridge when present, else the server. */
const openLocalPort = async (api: Api, port: number): Promise<void> => {
  const bridge = window.gram;
  if (bridge?.openLocalPort) await bridge.openLocalPort(port);
  else await openExternalUrl(api, localPortUrl(port));
};

/**
 * `:3000` chips for the ports a thread's processes listen on. A click opens the port in the
 * thread's Preview tab where there is one, and ⌘-click (Ctrl-click) in the browser; without the
 * tab, any click opens the browser. They sit inside row links, so they are `role="button"` spans
 * that swallow the click instead of nesting a button in an anchor. `compact` is the sidebar row's: a
 * lone port is a globe with its number in the tooltip, and several keep their numbers, which is all
 * that tells them apart.
 */
export function PortChips({
  threadId,
  ports,
  className,
  compact = false,
  tabbable = true,
}: {
  threadId: ThreadId;
  ports: readonly number[] | undefined;
  className?: string;
  compact?: boolean;
  /** False where the enclosing row is the Tab stop. */
  tabbable?: boolean;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const preview = useFeature("previewPane");
  if (ports === undefined || ports.length === 0) return null;

  // Into the thread's route as well as its pane: off a thread's page (Home, Settings, the board)
  // the right panel follows the route, not the grid.
  const previewPort = (port: number) => {
    const layout = useLayoutStore.getState();
    layout.openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
    layout.openPreview(threadId, localPortUrl(port), { thread: true });
  };

  const open = (event: MouseEvent | KeyboardEvent, port: number) => {
    event.preventDefault();
    event.stopPropagation();
    if (preview && !event.metaKey && !event.ctrlKey) previewPort(port);
    else void openLocalPort(api, port);
  };

  const outside = isMac() ? "⌘-click" : "Ctrl-click";
  const glyph = compact && ports.length === 1;
  return ports.map((port) => (
    <span
      key={port}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      data-testid={`port-chip-${port}`}
      title={
        preview
          ? `Preview ${localPortUrl(port)} (${outside} opens your browser)`
          : `Open ${localPortUrl(port)}`
      }
      className={cn(
        "flex shrink-0 cursor-pointer items-center rounded-sm font-mono hover:bg-accent hover:text-accent-foreground",
        !compact && "border border-border px-1",
        className,
      )}
      onClick={(event) => open(event, port)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") open(event, port);
      }}
    >
      {glyph && <Globe aria-hidden className="size-3" />}
      <span className={cn(glyph && "sr-only")}>:{port}</span>
    </span>
  ));
}
