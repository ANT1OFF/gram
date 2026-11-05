import { Globe, ShieldOff } from "lucide-react";

import { useTrustedLinks } from "@/links/trusted-links";

import { RowContextMenu, RowMenuButton, type RowAction } from "./row-menu";
import { SETTINGS_CARD } from "./settings-group";

/** Settings → General → Trusted links: the hosts whose links open without asking, to remove. */
export function TrustedLinksSection() {
  const { hosts, remove } = useTrustedLinks();
  if (hosts === undefined) return <p className="text-reading text-muted-foreground">Loading…</p>;
  if (hosts.length === 0) {
    return (
      <p className="px-1 text-reading text-muted-foreground">
        No trusted hosts: every link asks before it opens.
      </p>
    );
  }
  return (
    <ul data-testid="trusted-links" className={SETTINGS_CARD}>
      {hosts.map((host) => {
        const actions: RowAction[] = [
          { label: "Stop trusting", icon: ShieldOff, onSelect: () => remove(host) },
        ];
        return (
          <RowContextMenu
            key={host}
            actions={actions}
            render={<li aria-label={host} className="flex items-center gap-2 text-reading" />}
          >
            <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono">{host}</span>
            <RowMenuButton label={`Trusted host ${host} actions`} actions={actions} />
          </RowContextMenu>
        );
      })}
    </ul>
  );
}
