// @vitest-environment happy-dom
import type { AppUpdateState, DesktopBridge, UpdateCheck, UpdateSource } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { useUpdateStore } from "@/updates/store";

import { UpdatesPage } from "./pages";
import { UpdatesSection } from "./updates-section";

const CHECK: UpdateCheck = {
  available: true,
  currentVersion: "1.0.0",
  canSelfInstall: true,
  channel: "stable",
  latestVersion: "1.1.0",
  tag: "v1.1.0",
  releases: [
    { tag: "v1.1.0", version: "1.1.0", prerelease: false, relation: "newer" },
    { tag: "v1.0.0", version: "1.0.0", prerelease: false, relation: "current" },
    { tag: "v0.9.0", version: "0.9.0", prerelease: false, relation: "older" },
  ],
};

const fakeBridge = (overrides: Partial<UpdateCheck> = {}) => {
  const updates = {
    check: vi.fn(async () => ({ ...CHECK, ...overrides })),
    install: vi.fn(async () => ({ updating: false as const, error: "signature mismatch" })),
    onProgress: vi.fn(() => () => {}),
  };
  const bridge = { updates, openExternal: vi.fn(async () => true) } as unknown as DesktopBridge;
  Object.defineProperty(window, "gram", { value: bridge, configurable: true });
  return { updates, bridge };
};

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
  useUpdateStore.setState({
    installingTag: undefined,
    progress: undefined,
    latest: undefined,
    dismissed: undefined,
  });
});

describe("UpdatesSection", () => {
  it("explains that updates need the desktop app in a browser", () => {
    render(<UpdatesSection />);
    expect(screen.getByText(/managed by the desktop app/)).toBeTruthy();
  });

  it("checks the channel, lists releases and reports a failed install", async () => {
    const { updates } = fakeBridge();
    render(<UpdatesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/Version 1.1.0 is available/)).toBeTruthy();
    expect(updates.check).toHaveBeenCalledWith("stable");
    expect(screen.getByText("running version")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "signature mismatch");
    expect(updates.install).toHaveBeenCalledWith({
      channel: "stable",
      tag: "v1.1.0",
      downgrade: false,
    });
  });

  it("carries a check's short-lived install intent on the explicit install", async () => {
    const { updates } = fakeBridge({
      installId: "a".repeat(36),
      releases: [{ ...CHECK.releases![0]!, installId: "a".repeat(36) }],
    });
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await screen.findByRole("alert");
    expect(updates.install).toHaveBeenCalledWith({
      channel: "stable",
      tag: "v1.1.0",
      downgrade: false,
      installId: "a".repeat(36),
    });
  });

  it("offers an unsigned Mac no unsigned-updates opt-in and no automatic checks", async () => {
    const { bridge } = fakeBridge({
      available: false,
      unavailable: true,
      unavailableMessage: "Only Developer ID signed builds of Gram update themselves.",
      canSelfInstall: false,
      releases: [],
    });
    Object.assign(bridge, { platform: "darwin" });
    render(<UpdatesSection onPreferencesChange={vi.fn(async () => {})} />);
    expect(screen.queryByRole("switch", { name: "Unsigned private updates" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Check for updates automatically" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(
      await screen.findByText("Only Developer ID signed builds of Gram update themselves."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install|restart/ })).toBeNull();
  });

  it("says there's no update channel while Gram publishes no releases", async () => {
    fakeBridge({
      available: false,
      unavailable: true,
      noReleaseChannel: true,
      canSelfInstall: false,
      releases: [],
    });
    render(<UpdatesSection />);

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/doesn't publish releases yet/)).toBeTruthy();
    expect(screen.queryByText(/GitHub CLI/)).toBeNull();
  });

  it("says what the release source needs when it gives a reason, and gh's needs when it doesn't", async () => {
    fakeBridge({
      available: false,
      unavailable: true,
      unavailableMessage: "GitHub refused the linked account. Link GitHub again.",
      canSelfInstall: true,
    });
    const { unmount } = render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/Link GitHub again/)).toBeTruthy();
    expect(screen.queryByText(/GitHub CLI/)).toBeNull();
    unmount();

    fakeBridge({ available: false, unavailable: true, canSelfInstall: true });
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText(/GitHub CLI/)).toBeTruthy();
  });

  it("links to the release page when the build can't self-install", async () => {
    const { bridge } = fakeBridge({ canSelfInstall: false, htmlUrl: "https://example.test/r" });
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    fireEvent.click(await screen.findByRole("button", { name: "Open the release page" }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://example.test/r");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("checks the persisted channel and offers no choice of channel", async () => {
    const { updates } = fakeBridge();
    render(<UpdatesSection channel="prerelease" />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText(/Pre-release/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(updates.check).toHaveBeenCalledWith("prerelease");
  });

  it("doesn't call a pre-release the latest version on the stable channel", () => {
    fakeBridge();
    useUpdateStore.setState({
      latest: { ...CHECK, available: false, currentVersion: "1.2.0-rc.1" },
    });
    render(<UpdatesSection />);
    expect(screen.getByText(/pre-release 1.2.0-rc.1, which is ahead/)).toBeTruthy();
    expect(screen.queryByText(/latest version/)).toBeNull();

    cleanup();
    useUpdateStore.setState({
      latest: { ...CHECK, available: false, currentVersion: "0.1.0-rc.1", releases: [] },
    });
    render(<UpdatesSection />);
    expect(
      screen.getByText(/pre-release 0.1.0-rc.1, and there's no stable release yet/),
    ).toBeTruthy();
  });

  it("shows the latest automatic check without checking again", () => {
    const { updates } = fakeBridge();
    useUpdateStore.setState({ latest: CHECK });
    render(<UpdatesSection />);
    expect(screen.getByText(/Version 1.1.0 is available/)).toBeTruthy();
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("pins a downgrade before installing and restores the pin when the install fails", async () => {
    const { updates } = fakeBridge();
    useUpdateStore.setState({ latest: CHECK });
    const pins: Array<string | null> = [];
    const onPinChange = vi.fn(async (pin: string | null) => {
      pins.push(pin);
      expect(updates.install).toHaveBeenCalledTimes(pins.length === 1 ? 0 : 1);
    });
    render(<UpdatesSection onPinChange={onPinChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Downgrade" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "signature mismatch");
    expect(updates.install).toHaveBeenCalledWith({
      channel: "stable",
      tag: "v0.9.0",
      downgrade: true,
    });
    expect(pins).toEqual(["0.9.0", null]);
  });

  it("stores a pin again when it's the saved one, and asks on the check's channel", async () => {
    const { updates } = fakeBridge();
    useUpdateStore.setState({ latest: { ...CHECK, channel: "prerelease" } });
    const onPinChange = vi.fn(async () => {});
    render(<UpdatesSection channel="prerelease" pinnedVersion="0.9.0" onPinChange={onPinChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Downgrade" }));
    await screen.findByRole("alert");
    expect(onPinChange.mock.calls).toEqual([["0.9.0"]]);
    expect(updates.install).toHaveBeenCalledWith({
      channel: "prerelease",
      tag: "v0.9.0",
      downgrade: true,
    });
  });

  it("clears the pin when installing the newest release, and unpins on request", async () => {
    const { updates } = fakeBridge();
    useUpdateStore.setState({ latest: CHECK });
    const onPinChange = vi.fn(async () => {});
    render(<UpdatesSection pinnedVersion="1.0.0" onPinChange={onPinChange} />);
    expect(screen.getByText(/Pinned to 1.0.0/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await screen.findByRole("alert");
    expect(updates.install).toHaveBeenCalledWith(expect.objectContaining({ tag: "v1.1.0" }));
    expect(onPinChange.mock.calls).toEqual([[null], ["1.0.0"]]);

    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(onPinChange).toHaveBeenLastCalledWith(null);
  });
});

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider api={{ diagnostics: async () => ({}) } as unknown as Api}>
        <UpdatesPage />
      </ApiProvider>
    </QueryClientProvider>,
  );

describe("Settings → Updates", () => {
  it("keeps the desktop's channel and check, without the switch", async () => {
    fakeBridge();
    renderPage();
    expect(await screen.findByRole("button", { name: "Check for updates" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Get pre-releases" })).toBeNull();
  });
});

describe("Settings → Updates on a signed install", () => {
  const signed: AppUpdateState = {
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
  const nativeBridge = (answer: Partial<AppUpdateState> = {}) => {
    const resolve = async () => ({ ...signed, ...answer });
    const native = {
      state: vi.fn(resolve),
      onState: vi.fn(() => () => {}),
      check: vi.fn(resolve),
      download: vi.fn(resolve),
      install: vi.fn(resolve),
      dismiss: vi.fn(resolve),
    };
    const { updates } = fakeBridge();
    Object.assign(updates, { native });
    return { native, updates };
  };
  const showNative = (patch: Partial<AppUpdateState>) =>
    act(() => useUpdateStore.setState({ native: { ...signed, ...patch } }));
  afterEach(() => useUpdateStore.setState({ native: undefined }));

  it("shows neither updater until main has said which this install uses", () => {
    nativeBridge();
    render(<UpdatesSection channel="prerelease" />);
    expect(screen.getByText("Reading the update status…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });

  it("shows Electron's updater instead of the private release list", () => {
    const { updates } = nativeBridge();
    showNative({ status: "upToDate", checkedAt: Date.now() });
    render(<UpdatesSection channel="prerelease" />);
    expect(screen.getByTestId("updates").dataset["native"]).toBe("true");
    expect(screen.getByTestId("native-status").textContent).toMatch(
      /Up to date · checked \d\d:\d\d/,
    );
    expect(screen.queryByRole("switch", { name: "Unsigned private updates" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Releases" })).toBeNull();
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("checks, downloads and restarts through the same states as the pill", async () => {
    const { native } = nativeBridge({ status: "checking", manual: true });
    showNative({});
    render(<UpdatesSection channel="prerelease" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    });
    expect(native.check).toHaveBeenCalledWith("prerelease");

    showNative({ status: "available", availableVersion: "0.1.0-rc.18", releaseNotes: "Notes" });
    expect(screen.getByRole("region", { name: "Release notes" }).textContent).toMatch(/Notes/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download 0.1.0-rc.18" }));
    });
    expect(native.download).toHaveBeenCalledOnce();

    showNative({ status: "downloading", availableVersion: "0.1.0-rc.18", percent: 42 });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByRole("button", { name: "Check for updates" })).toHaveProperty(
      "disabled",
      true,
    );

    showNative({
      status: "ready",
      availableVersion: "0.1.0-rc.18",
      downloadedVersion: "0.1.0-rc.18",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    });
    expect(native.install).toHaveBeenCalledWith("0.1.0-rc.18");
  });

  it("shows a refused restart's reason and offers it again", async () => {
    const { native } = nativeBridge();
    showNative({
      status: "error",
      errorStep: "install",
      downloadedVersion: "0.1.0-rc.18",
      message: "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
    });
    render(<UpdatesSection channel="prerelease" />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Didn't restart: an agent didn't stop cleanly. Nothing was installed.",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try the restart again" }));
    });
    expect(native.install).toHaveBeenCalledWith("0.1.0-rc.18");
  });

  it("says an update wasn't applied until dismissed", async () => {
    const { native } = nativeBridge();
    showNative({ notApplied: { version: "0.1.0-rc.18", reason: "See ShipIt_stderr.log." } });
    render(<UpdatesSection channel="prerelease" />);
    expect(screen.getByTestId("not-applied").textContent).toMatch(
      /Gram 0\.1\.0-rc\.18 wasn't applied\. See ShipIt_stderr\.log\./,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(native.dismiss).toHaveBeenCalledOnce();
  });

  it("offers no choice of channel", () => {
    nativeBridge();
    showNative({});
    render(<UpdatesSection />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByTestId("updates").textContent).not.toMatch(/Pre-release|channel/i);
  });

  it("names the public repository the updater reads, without gh", async () => {
    const { updates } = nativeBridge();
    const source = Promise.withResolvers<UpdateSource>();
    Object.assign(updates, { source: vi.fn(() => source.promise) });
    showNative({ status: "upToDate", checkedAt: Date.now() });
    render(<UpdatesSection channel="prerelease" />);
    const note = await screen.findByText(/Releases are read anonymously/);
    // The generic note exists before updates.source answers. Its presence is not source readiness.
    expect(note.textContent).toContain("Gram's public release repository");
    expect(note.textContent).not.toContain("example/gram");
    await act(async () => {
      source.resolve({ repo: "example/gram", visibility: "public" });
    });
    expect(note.textContent).toContain(
      "Releases are read anonymously from the public example/gram repository; no sign-in is needed.",
    );
    expect(screen.getByTestId("updates").textContent).not.toMatch(/\bgh\b|ANT1OFF/);
  });
});

describe("the gh updater's copy", () => {
  it("names the repository it reads with gh", async () => {
    const { updates } = fakeBridge();
    Object.assign(updates, {
      source: vi.fn(async () => ({ repo: "example/gram", visibility: "private" as const })),
    });
    Object.assign(window.gram!, { platform: "win32" });
    render(<UpdatesSection channel="stable" />);
    expect(
      await screen.findByText(
        "Check for private example/gram releases with your gh login. Never installs or interrupts agents.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("updates").textContent).not.toContain("ANT1OFF");
  });
});
