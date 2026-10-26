import { expect, test } from "@playwright/test";

// A synthetic unsigned macOS shell: main gives it no signed updater (`native.state` is null) and
// its checks answer unavailable, as `unavailableUpdater` does. Nothing here reads host gh state.
for (const width of [1280, 390]) {
  test(`an unsigned Mac shows updates as unavailable, with nothing to opt into, at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      const message =
        "Only Developer ID signed builds of Gram update themselves. Install a signed release to get updates.";
      Object.defineProperty(window, "gram", {
        configurable: true,
        value: {
          platform: "darwin",
          appBuildInfo: async () => ({
            version: "0.1.0-rc.2",
            packaged: true,
            sourceCommit: "a".repeat(40),
          }),
          onMenu: () => () => {},
          onNotificationClick: () => () => {},
          setBadge() {},
          notify() {},
          setTitleBarTheme() {},
          setVibrancy() {},
          setMenuShortcuts() {},
          reportConnection() {},
          windowLayout: async () => null,
          setWindowLayout() {},
          listFonts: async () => [],
          trustedLinks: async () => [],
          openExternal: async () => true,
          updates: {
            autoCheck: async () => false,
            onProgress: () => () => {},
            check: async (channel: "stable" | "prerelease") => {
              calls.push(channel);
              return {
                available: false,
                unavailable: true,
                unavailableMessage: message,
                currentVersion: "0.1.0-rc.2",
                canSelfInstall: false,
                channel,
              };
            },
            install: async (intent: unknown) => {
              calls.push(intent);
              return { updating: false, error: message };
            },
            native: {
              state: async () => null,
              onState: () => () => {},
              check: async () => null,
              download: async () => null,
              install: async () => null,
              dismiss: async () => null,
            },
          },
        },
      });
      Object.defineProperty(window, "updateCalls", { value: calls });
    });
    await page.goto("/settings/updates");
    const section = page.getByTestId("updates");
    await expect(section.getByTestId("build-status")).toContainText("Running Gram 0.1.0-rc.2");
    await expect(section.getByTestId("build-status")).toContainText("Not checked yet");
    await expect(section.getByRole("switch", { name: "Unsigned private updates" })).toHaveCount(0);
    await expect(
      section.getByRole("switch", { name: "Check for updates automatically" }),
    ).toHaveCount(0);

    await section.getByRole("button", { name: "Check for updates" }).click();
    await expect(section).toContainText(
      "Only Developer ID signed builds of Gram update themselves.",
    );
    await expect(section.getByTestId("build-status")).toContainText("Last checked: Stable");
    await expect(section.getByRole("list", { name: "Releases" })).toHaveCount(0);
    await expect(section.getByRole("button", { name: /Install|restart/i })).toHaveCount(0);
    await expect(page.getByTestId("update-notice")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { updateCalls: unknown[] }).updateCalls),
    ).toEqual(["stable"]);
  });
}
