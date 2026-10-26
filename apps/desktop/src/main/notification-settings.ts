// Settings' notification row, the shell's half: the system's notification settings for Gram, and
// the test notification. What happened to it is `core/notification-status.ts`'s to report.

/** The system's notification settings, on Gram's own page where the OS has one. */
export const notificationSettingsUrl = (
  platform: NodeJS.Platform,
  appId: string,
): string | undefined =>
  platform === "darwin"
    ? `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(appId)}`
    : platform === "win32"
      ? "ms-settings:notifications"
      : undefined;

/** Opens them; false where there are none to open, or they wouldn't open. */
export async function openNotificationSettings(deps: {
  readonly platform: NodeJS.Platform;
  readonly appId: string;
  readonly openExternal: (url: string) => Promise<void>;
}): Promise<boolean> {
  const url = notificationSettingsUrl(deps.platform, deps.appId);
  if (url === undefined) return false;
  try {
    await deps.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

export const TEST_NOTIFICATION = {
  title: "Gram notifications work",
  body: "The test from Settings. Click it to go back there.",
} as const;
