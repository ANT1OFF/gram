import { bindingRows } from "@/keyboard/bindings";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { listedShortcuts, SHORTCUT_CATALOG } from "@/keyboard/catalog";
import { formatKeys } from "@/keyboard/registry";
import { useServerSettings } from "@/settings-sync/store";

import { filterShortcuts, groupShortcuts } from "./shortcut-groups";

/**
 * Every shortcut in the catalog with the user's bindings applied, grouped, for the `?` overlay. It
 * lists shortcuts whose screen isn't open too, so the overlay reads the same from anywhere; `query`
 * narrows it by name, area or keys.
 */
export function ShortcutList({ query = "" }: { query?: string }) {
  const overrides = useBindingsStore((s) => s.overrides);
  const settings = useServerSettings((s) => s.settings);
  const sections = filterShortcuts(
    groupShortcuts(bindingRows(listedShortcuts(SHORTCUT_CATALOG, settings), overrides)),
    query,
    (keys) => formatKeys(keys),
  );

  if (sections.length === 0) {
    return (
      <p
        data-testid="shortcut-empty"
        className="py-6 text-center text-reading text-muted-foreground"
      >
        No matches
      </p>
    );
  }

  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {sections.map((section) => (
        <section key={section.group} aria-label={section.group} data-testid="shortcut-section">
          <h3 className="mb-1 text-meta font-medium text-muted-foreground">{section.group}</h3>
          <dl className="flex flex-col gap-1 text-body">
            {section.rows.map((row) => (
              <div key={row.id} data-shortcut-id={row.id} className="flex items-center gap-2">
                <dt className="truncate" title={row.label}>
                  {row.label}
                </dt>
                <dd className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
                  {row.keys.map((keys) => (
                    <kbd
                      key={keys}
                      className="rounded-2xs border border-border bg-muted px-1.5 py-0.5 font-mono text-caption"
                    >
                      {formatKeys(keys)}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
