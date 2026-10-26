import type { AppUpdateState } from "@gram/contracts";
import type { Page } from "@playwright/test";

/** A signed install's updater state with nothing found yet; shots and tests patch it. */
const NATIVE_IDLE: AppUpdateState = {
  status: "idle",
  channel: "prerelease",
  currentVersion: "0.1.0-rc.17",
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: null,
  releaseDate: null,
  percent: null,
  checkedAt: null,
  manual: false,
  message: null,
  errorStep: null,
  notApplied: null,
  canInstall: true,
};

/**
 * A synthetic desktop bridge whose Electron updater reports `state` (kept in sessionStorage, so it
 * survives reloads). Browser-owned only: no backend, native updater, `gh` or accounts.
 */
export async function seedNativeUpdate(page: Page, patch: Partial<AppUpdateState>) {
  await page.addInitScript(
    ({ state }) => {
      const key = "gram.fixture.nativeUpdate";
      sessionStorage.setItem(key, JSON.stringify(state));
      const read = async () => JSON.parse(sessionStorage.getItem(key)!) as unknown;
      Object.defineProperty(window, "gram", {
        configurable: true,
        value: {
          platform: "darwin",
          appBuildInfo: async () => ({
            version: state.currentVersion,
            packaged: true,
            sourceCommit: "c".repeat(40),
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
            native: {
              state: read,
              onState: () => () => {},
              check: read,
              download: read,
              install: read,
              dismiss: read,
            },
          },
        },
      });
    },
    { state: { ...NATIVE_IDLE, ...patch } },
  );
}
