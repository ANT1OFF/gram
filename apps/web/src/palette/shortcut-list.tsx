import { bindingRows } from "@/keyboard/bindings";
import { useBindingsStore } from "@/keyboard/bindings-store";
import { listedShortcuts, SHORTCUT_CATALOG } from "@/keyboard/catalog";
import { formatKeys } from "@/keyboard/registry";
import { useServerSettings } from "@/settings-sync/store";

import { groupShortcuts } from "./shortcut-groups";

/**
 * Every shortcut in the catalog with the user's bindings applied, grouped, for the `?` overlay. It
 * lists shortcuts whose screen isn't open too, so the overlay reads the same from anywhere.
 */
export function ShortcutList() {
  const overrides = useBindingsStore((s) => s.overrides);
  const settings = useServerSettings((s) => s.settings);
  const sections = groupShortcuts(
    bindingRows(listedShortcuts(SHORTCUT_CATALOG, settings), overrides),
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sections.map((section) => (
        <section key={section.group} aria-label={section.group}>
          <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {section.group}
          </h3>
          <dl className="flex flex-col gap-1 text-sm">
            {section.rows.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <dt className="truncate">{row.label}</dt>
                <dd className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
                  {row.keys.map((keys) => (
                    <kbd
                      key={keys}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs"
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
