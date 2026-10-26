import { Globe, ShieldOff } from "lucide-react";

import { useAgentBrowseHosts } from "@/links/agent-browse";

import { RowContextMenu, RowMenuButton, type RowAction } from "./row-menu";
import { SETTINGS_CARD } from "./settings-group";

/** Settings → General → Agent may browse: the public hosts agents open without asking, to remove. */
export function AgentBrowseSection() {
  const { hosts, remove } = useAgentBrowseHosts();
  if (hosts === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (hosts.length === 0) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        No hosts: an agent asks before it opens any public site.
      </p>
    );
  }
  return (
    <ul data-testid="agent-browse-hosts" className={SETTINGS_CARD}>
      {hosts.map((host) => {
        const actions: RowAction[] = [
          { label: "Stop allowing", icon: ShieldOff, onSelect: () => remove(host) },
        ];
        return (
          <RowContextMenu
            key={host}
            actions={actions}
            render={<li aria-label={host} className="flex items-center gap-2 text-sm" />}
          >
            <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono">{host}</span>
            <RowMenuButton label={`Agent browse host ${host} actions`} actions={actions} />
          </RowContextMenu>
        );
      })}
    </ul>
  );
}
