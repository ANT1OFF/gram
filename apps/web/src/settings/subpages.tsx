import { reviewBotsOf } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";
import { decideUpdateNotice } from "@/updates/launch-check";
import { useUpdateStore } from "@/updates/store";

import { GROUP_TITLE, SETTINGS_CARD } from "./settings-group";

/**
 * One page that opens from a group, as a row laid out like a setting: its name and what it is for
 * on the left, a short value and the way in on the right.
 */
export function SubpageRow({
  label,
  description,
  to,
  search,
  summary,
  badge,
}: {
  label: string;
  description?: string;
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
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-medium">
          {label}
          {badge}
        </span>
        {description !== undefined && (
          <span className="text-meta text-muted-foreground">{description}</span>
        )}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">{summary}</span>
      <ChevronRight aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
    </Link>
  );
}

/** The rows of a group's own pages, in a card under a title, at the end of the group's page. */
export function SubpageList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} data-testid="settings-subpages" className="flex flex-col gap-2">
      <h3 className={`${GROUP_TITLE} px-1`}>{label}</h3>
      <div className={SETTINGS_CARD}>{children}</div>
    </nav>
  );
}

/** Agents & models → AI helpers: whether the helper model runs. */
export function AiHelpersSummary() {
  const on = useServerSettings((s) => s.settings?.helpers?.enabled !== false);
  return on ? "On" : "Off";
}

/** Agents & models → Gateways: how many are set up. */
export function GatewaysSummary() {
  const api = useApi();
  const { data } = useQuery({ queryKey: ["profiles"], queryFn: () => api.listProfiles() });
  if (data === undefined) return null;
  return data.length === 0 ? "None" : String(data.length);
}

/** Workspaces & merging → Routines: how many there are across the workspaces. */
export function RoutinesSummary() {
  const api = useApi();
  const { data } = useQuery({ queryKey: ["workspaces"], queryFn: () => api.listWorkspaces() });
  if (data === undefined) return null;
  const count = data.reduce((sum, state) => sum + (state.charter.routines?.length ?? 0), 0);
  return count === 0 ? "None" : String(count);
}

/** Workspaces & merging → Review bots: how many are followed. */
export function ReviewBotsSummary() {
  const count = useServerSettings((s) => (s.settings ? reviewBotsOf(s.settings).length : 0));
  return count === 0 ? "None" : String(count);
}

/** Appearance → Terminal: the shell it starts. */
export function TerminalSummary() {
  return useServerSettings((s) => s.settings?.terminal.shell ?? "powershell");
}

/** Whether a newer release than the pinned one is out, for the dot on About. */
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
