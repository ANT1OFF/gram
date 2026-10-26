import { reviewBotsOf } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { useServerSettings } from "@/settings-sync/store";
import { decideUpdateNotice } from "@/updates/launch-check";
import { useUpdateStore } from "@/updates/store";

import { SETTINGS_CARD } from "./settings-group";

/** One page that opens from a group, as a row: its name, a short value, and the way in. */
export function SubpageRow({
  label,
  to,
  search,
  summary,
  badge,
}: {
  label: string;
  to: string;
  search?: { highlight: string };
  summary?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <Link
      to={to}
      {...(search === undefined ? {} : { search })}
      data-testid="settings-subpage-row"
      className="flex min-h-9 items-center gap-3 outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset first:rounded-t-lg last:rounded-b-lg"
    >
      <span className="font-medium">{label}</span>
      {badge}
      <span className="ms-auto truncate text-muted-foreground tabular-nums">{summary}</span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

/** The rows of a group's pages, in a card. */
export function SubpageList({ children }: { children: ReactNode }) {
  return (
    <nav aria-label="More settings" data-testid="settings-subpages" className={SETTINGS_CARD}>
      {children}
    </nav>
  );
}

/** Advanced → Review bots: how many are followed. */
export function ReviewBotsSummary() {
  const count = useServerSettings((s) => (s.settings ? reviewBotsOf(s.settings).length : 0));
  return count === 0 ? "None" : String(count);
}

/** Advanced → Terminal: the shell it starts. */
export function TerminalSummary() {
  return useServerSettings((s) => s.settings?.terminal.shell ?? "powershell");
}

/** Whether a newer release than the pinned one is out, for the dot on Advanced and Updates. */
export function useUpdateAvailable(): boolean {
  const pinnedVersion = useServerSettings((s) => s.settings?.updates.pinnedVersion);
  return useUpdateStore(
    (s) =>
      s.native?.status === "available" ||
      s.native?.status === "ready" ||
      (s.latest !== undefined &&
        decideUpdateNotice(s.latest, pinnedVersion).announce !== undefined),
  );
}

/** The dot that says an update is out. */
export function UpdateDot() {
  return (
    <span
      role="img"
      aria-label="Update available"
      data-testid="updates-badge"
      className="size-1.5 shrink-0 rounded-full bg-primary"
    />
  );
}
