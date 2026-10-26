import type { SessionRestartData } from "@gram/contracts";
import { RotateCw } from "lucide-react";

import { dateTimeFormat } from "@/lib/intl";
import { CLOCK_TIME } from "@/lib/time";
import { useNow } from "@/lib/use-now";

const DATE = { day: "numeric", month: "short" } as const;

/**
 * The marker's line: `Session restarted · config reloaded · 14:32`, or `· MCP config changed ·` for
 * a restart Gram made on its own, with the date before the time when it wasn't today.
 * `intl` pins the locale and zone, for tests.
 */
export const sessionRestartLabel = (
  restart: SessionRestartData,
  now: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): string => {
  const zone = intl.timeZone === undefined ? {} : { timeZone: intl.timeZone };
  const format = (at: number, options: Intl.DateTimeFormatOptions) =>
    dateTimeFormat(intl.locale, { ...options, ...zone }).format(at);
  const today = format(restart.at, DATE) === format(now, DATE);
  const why = restart.reason === "mcpConfig" ? "MCP config changed" : "config reloaded";
  return `Session restarted · ${why} · ${format(restart.at, today ? CLOCK_TIME : { ...DATE, ...CLOCK_TIME })}`;
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
      className="my-3 flex w-full items-center gap-3 text-xs text-muted-foreground"
    >
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <RotateCw aria-hidden className="size-3 shrink-0" />
        <span className="text-center">{label}</span>
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}
