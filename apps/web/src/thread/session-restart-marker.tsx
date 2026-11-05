import type { SessionRestartData } from "@gram/contracts";
import { RotateCw } from "lucide-react";

import { formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";

/**
 * The marker's line: `Session restarted · config reloaded · 14:32`, or `· MCP config changed ·` for
 * a restart Gram made on its own, with the date before the time when it wasn't today
 * (`formatStamp`). `intl` pins the zone, for tests.
 */
export const sessionRestartLabel = (
  restart: SessionRestartData,
  now: number,
  intl: { readonly timeZone?: string } = {},
): string => {
  const why = restart.reason === "mcpConfig" ? "MCP config changed" : "config reloaded";
  return `Session restarted · ${why} · ${formatStamp(restart.at, now, intl)}`;
};

/** Where the agent session was restarted to reload its config, as a quiet divider like a compaction's. */
export function SessionRestartMarker({ restart }: { restart: SessionRestartData }) {
  // Only to tell today from another day, so read once rather than on a clock.
  const now = useNow(false);
  const label = sessionRestartLabel(restart, now);
  return (
    <div
      role="separator"
      aria-label={label}
      title={
        restart.reason === "mcpConfig"
          ? "An MCP server or connector this agent uses changed, so its session was restarted on the same conversation once it was idle, to load it."
          : "The agent's session was restarted on the same conversation, and read its settings, MCP servers, connectors, instructions and skills again."
      }
      data-testid="session-restart"
      className="my-3 flex w-full items-center gap-3 text-meta text-muted-foreground"
    >
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <RotateCw aria-hidden className="size-3.5 shrink-0" />
        <span className="text-center">{label}</span>
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}
