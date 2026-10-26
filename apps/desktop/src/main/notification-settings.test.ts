import { expect, it, vi } from "vitest";

import { notificationSettingsUrl, openNotificationSettings } from "./notification-settings.ts";

it("opens Gram's own page in macOS Notifications, the Windows page, and nothing on Linux", async () => {
  expect(notificationSettingsUrl("darwin", "io.github.ant1off.gram")).toBe(
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=io.github.ant1off.gram",
  );
  expect(notificationSettingsUrl("win32", "io.github.ant1off.gram")).toBe(
    "ms-settings:notifications",
  );
  const openExternal = vi.fn(async (_url: string) => {});
  const appId = "io.github.ant1off.gram";
  expect(await openNotificationSettings({ platform: "linux", appId, openExternal })).toBe(false);
  expect(openExternal).not.toHaveBeenCalled();
  expect(await openNotificationSettings({ platform: "darwin", appId, openExternal })).toBe(true);
  openExternal.mockRejectedValueOnce(new Error("no pane"));
  expect(await openNotificationSettings({ platform: "darwin", appId, openExternal })).toBe(false);
});
