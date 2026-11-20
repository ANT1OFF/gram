import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { ChartNoAxesCombined, Settings } from "lucide-react";

import { MENU_ITEM } from "@/lib/selection";
import { useOpenSettings } from "@/settings/open-settings";

// The window's own places, in words, for the title bar's "…" menu when the bar has no room for
// their icons.

/** Usage in words, for a bar with no room for its meter. */
export function UsageItem() {
  const navigate = useNavigate();
  return (
    <Menu.Item
      data-testid="phone-menu-usage"
      className={MENU_ITEM}
      onClick={() => void navigate({ to: "/settings/usage" })}
    >
      <ChartNoAxesCombined aria-hidden />
      Usage
    </Menu.Item>
  );
}

/** Settings in words, for a bar with no room for its icon. */
export function SettingsItem() {
  const openSettings = useOpenSettings();
  return (
    <Menu.Item data-testid="phone-menu-settings" className={MENU_ITEM} onClick={openSettings}>
      <Settings aria-hidden />
      Settings
    </Menu.Item>
  );
}
