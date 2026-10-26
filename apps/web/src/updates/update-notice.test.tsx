// @vitest-environment happy-dom
import type { DesktopBridge, Settings, SettingsPatch, UpdateCheck } from "@gram/contracts";
import { DEFAULT_SETTINGS } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useServerSettings } from "@/settings-sync/store";

import { useUpdateStore } from "./store";
import { UpdateNotice } from "./update-notice";

const AVAILABLE: UpdateCheck = {
  available: true,
  currentVersion: "1.0.0",
  canSelfInstall: true,
  channel: "stable",
  latestVersion: "1.2.0",
  tag: "v1.2.0",
  htmlUrl: "https://example.test/r",
};

const fakeBridge = (platform = "win32") => {
  const updates = {
    install: vi.fn(async () => ({ updating: false as const, error: "no network" })),
    onProgress: vi.fn(() => () => {}),
  };
  const bridge = {
    updates,
    platform,
    openExternal: vi.fn(async () => true),
  } as unknown as DesktopBridge;
  Object.defineProperty(window, "gram", { value: bridge, configurable: true });
  return { updates, bridge };
};

const withPin = (pinnedVersion: string | undefined): Settings => ({
  ...DEFAULT_SETTINGS,
  updates: { channel: "stable", ...(pinnedVersion ? { pinnedVersion } : {}) },
});

const updateSettings = vi.fn(async (patch: SettingsPatch) =>
  withPin(patch.updates?.pinnedVersion ?? undefined),
);
const wrapper = ({ children }: { children: ReactNode }) => (
  <ApiProvider api={{ updateSettings } as unknown as Api}>{children}</ApiProvider>
);
const renderNotice = () => render(<UpdateNotice />, { wrapper });

afterEach(() => {
  cleanup();
  updateSettings.mockClear();
  Reflect.deleteProperty(window, "gram");
  useUpdateStore.setState({
    installingTag: undefined,
    progress: undefined,
    latest: undefined,
    dismissed: undefined,
  });
  useServerSettings.setState({ settings: undefined });
});

describe("UpdateNotice", () => {
  it.each(["requesting", "downloading", "verifying", "installing", "failed"] as const)(
    "binds %s identity and notes to the selected target, separately from the newer offer",
    (stage) => {
      const { bridge, updates } = fakeBridge();
      const selected = {
        tag: "v0.1.0-rc.3",
        version: "0.1.0-rc.3",
        prerelease: true,
        relation: "newer" as const,
        notes: "Selected RC THREE changes",
        htmlUrl: "https://github.com/ANT1OFF/gram/releases/tag/v0.1.0-rc.3",
      };
      const newest = {
        ...selected,
        tag: "v0.1.0-rc.4",
        version: "0.1.0-rc.4",
        notes: "Newest RC FOUR changes",
        htmlUrl: "https://github.com/ANT1OFF/gram/releases/tag/v0.1.0-rc.4",
      };
      useServerSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          updates: { channel: "prerelease" },
        },
      });
      useUpdateStore.setState({
        latest: {
          ...AVAILABLE,
          channel: "prerelease",
          currentVersion: "0.1.0-rc.2",
          latestVersion: newest.version,
          tag: newest.tag,
          htmlUrl: newest.htmlUrl,
          releases: [newest, selected],
        },
        ...(stage === "requesting"
          ? { installingTag: selected.tag }
          : {
              progress: {
                stage,
                tag: selected.tag,
                ...(stage === "failed" ? { error: "Synthetic selected-target failure" } : {}),
              },
            }),
      });
      renderNotice();
      const notice = screen.getByTestId("update-notice");
      expect(notice.textContent).toContain("v0.1.0-rc.3");
      expect(notice.textContent).toContain("Running 0.1.0-rc.2");
      expect(notice.textContent).toContain("Selected RC THREE changes");
      expect(notice.textContent).not.toContain("Newest RC FOUR changes");
      expect(notice.textContent).toContain("Available release: 0.1.0-rc.4");
      fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
      expect(bridge.openExternal).toHaveBeenCalledWith(selected.htmlUrl);
      expect(updates.install).not.toHaveBeenCalled();
      if (stage !== "failed") {
        expect(
          screen.getByRole("button", { name: "Update to 0.1.0-rc.4 and restart" }),
        ).toHaveProperty("disabled", true);
        expect(screen.getByRole("button", { name: "Later" })).toHaveProperty("disabled", true);
      } else {
        expect(screen.getByRole("alert").textContent).toContain(
          "Synthetic selected-target failure",
        );
        fireEvent.click(screen.getByRole("button", { name: "Later" }));
        expect(screen.queryByTestId("update-notice")).toBeNull();
      }
    },
  );

  it("keeps a pending target visible without an offer or matching optional release metadata", () => {
    fakeBridge();
    useUpdateStore.setState({
      latest: AVAILABLE,
      dismissed: AVAILABLE.latestVersion,
      progress: { stage: "downloading", tag: "v1.1.0" },
    });
    renderNotice();
    expect(screen.getByTestId("update-notice").textContent).toContain("v1.1.0");
    expect(screen.queryByRole("button", { name: "Release notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
  });

  it("says nothing on an unsigned Mac, whose checks are unavailable", () => {
    fakeBridge("darwin");
    useUpdateStore.setState({
      latest: {
        available: false,
        unavailable: true,
        unavailableMessage: "Only Developer ID signed builds of Gram update themselves.",
        currentVersion: "1.0.0",
        canSelfInstall: false,
        channel: "stable",
      },
    });
    renderNotice();
    expect(screen.queryByTestId("update-notice")).toBeNull();
  });

  it("installs only on click and reports a failure", async () => {
    const { updates } = fakeBridge();
    useUpdateStore.setState({ latest: AVAILABLE });
    renderNotice();

    expect(screen.getByText("Update available: 1.2.0")).toBeTruthy();
    expect(updates.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(await screen.findByText(/no network/)).toBeTruthy();
    expect(updates.install).toHaveBeenCalledWith({
      channel: "stable",
      tag: "v1.2.0",
      downgrade: false,
    });
  });

  it("sends only the shown install ID for renewal, without renderer source authority", async () => {
    const { updates } = fakeBridge();
    const installId = "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12);
    const shown = {
      tag: "v1.2.0",
      version: "1.2.0",
      prerelease: false,
      relation: "newer" as const,
      installId,
      sourceCommit: "c".repeat(40),
    };
    useUpdateStore.setState({ latest: { ...AVAILABLE, installId, releases: [shown] } });
    renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(await screen.findByText(/no network/)).toBeTruthy();
    expect(updates.install).toHaveBeenCalledWith({
      channel: "stable",
      tag: "v1.2.0",
      downgrade: false,
      installId,
    });
  });

  it("links to the release page when the build can't self-install", () => {
    const { bridge } = fakeBridge();
    useUpdateStore.setState({ latest: { ...AVAILABLE, canSelfInstall: false } });
    renderNotice();
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://example.test/r");
  });

  it("hides for a dismissed version and while the running version is pinned", () => {
    fakeBridge();
    useUpdateStore.setState({ latest: AVAILABLE });
    const { rerender } = renderNotice();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByTestId("update-notice")).toBeNull();

    useUpdateStore.setState({ dismissed: undefined });
    useServerSettings.setState({ settings: withPin("1.0.0") });
    rerender(<UpdateNotice />);
    expect(screen.queryByTestId("update-notice")).toBeNull();
  });
});
