import type { FolderSettings } from "@gram/contracts";
import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import { formatKeys } from "@/keyboard/registry";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a folder brings that would run as the user, one line per kind, as the trust question lists. */
export function FolderSettingsList({ settings }: { settings: FolderSettings }) {
  const rows: Array<{ key: string; label: string; detail?: ReactNode }> = [];
  if (settings.hooks.length > 0)
    rows.push({
      key: "hooks",
      label: count(settings.hooks.length, "hook"),
      detail: settings.hooks
        .slice(0, 3)
        .map((hook) => `${hook.event}: ${hook.command || "(no command)"}`)
        .join(", "),
    });
  if (settings.mcpServers.length > 0)
    rows.push({
      key: "mcp",
      label: count(settings.mcpServers.length, "MCP server"),
      detail: settings.mcpServers.join(", "),
    });
  if (settings.allowRules > 0)
    rows.push({ key: "rules", label: count(settings.allowRules, "allow rule") });
  if (settings.env.length > 0)
    rows.push({
      key: "env",
      label: count(settings.env.length, "environment variable"),
      detail: settings.env.join(", "),
    });
  if (settings.commands.length > 0)
    rows.push({
      key: "commands",
      label: count(settings.commands.length, "command setting"),
      detail: settings.commands.join(", "),
    });
  if (settings.scripts.length > 0) {
    const keyed = settings.scripts.filter((script) => script.shortcut !== undefined);
    rows.push({
      key: "scripts",
      label:
        keyed.length === 0
          ? count(settings.scripts.length, "script")
          : `${count(settings.scripts.length, "script")}, ${keyed.length} with a shortcut`,
      detail: keyed
        .slice(0, 3)
        .map((script) => `${formatKeys(script.shortcut!)} ${script.name}`)
        .join(", "),
    });
  }
  if (settings.unreadable.length > 0)
    rows.push({
      key: "unreadable",
      label: count(settings.unreadable.length, "file Gram couldn't read"),
      detail: settings.unreadable.join(", "),
    });
  if (settings.other.length > 0)
    rows.push({
      key: "other",
      label: count(settings.other.length, "other setting"),
      detail: settings.other.join(", "),
    });
  return (
    <ul className="flex flex-col gap-0.5 text-meta" data-testid="folder-settings">
      {rows.map((row) => (
        <li key={row.key} className="flex min-w-0 gap-1.5">
          <span className="shrink-0 font-medium">{row.label}</span>
          {row.detail !== undefined && row.detail !== "" && (
            <span className="min-w-0 truncate font-mono text-muted-foreground">{row.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The question Gram asks once per folder: its own agent settings and scripts run as the user, so
 * they load only if the user says so. `actions` are the answers, laid out by the caller.
 */
export function FolderTrustQuestion({
  settings,
  actions,
}: {
  settings: FolderSettings;
  actions: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label="Trust this folder?"
      data-testid="folder-trust-question"
      className="flex flex-col gap-2 rounded-lg border border-edge bg-muted/40 p-2.5"
    >
      <p className="flex items-start gap-1.5 text-meta">
        <ShieldAlert aria-hidden className="mt-px size-icon-row shrink-0 text-warning-text" />
        This folder has its own agent settings. They run as you in every thread here. Without them,
        its CLAUDE.md doesn't load either.
      </p>
      <FolderSettingsList settings={settings} />
      <div className="flex flex-wrap justify-end gap-1">{actions}</div>
      <p className="text-meta text-muted-foreground">
        You can change this later in the project's row. Gram won't ask again for this folder.
      </p>
    </div>
  );
}
