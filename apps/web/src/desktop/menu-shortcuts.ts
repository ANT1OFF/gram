import { MENU_SHORTCUT_IDS, type MenuShortcuts } from "@gram/contracts";

import { effectiveKeys, type BindingOverrides } from "@/keyboard/bindings-store";
import { catalogKeys } from "@/keyboard/catalog";

/** The desktop menu's shortcuts with the user's bindings applied; `null` where one is turned off. */
export function menuShortcuts(overrides: BindingOverrides): MenuShortcuts {
  return Object.fromEntries(
    MENU_SHORTCUT_IDS.map((id) => [
      id,
      effectiveKeys(id, catalogKeys(id) ?? "", overrides) ?? null,
    ]),
  );
}
