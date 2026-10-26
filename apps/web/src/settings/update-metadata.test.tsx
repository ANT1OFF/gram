// @vitest-environment happy-dom
import type { DesktopBridge, UpdateProgress } from "@gram/contracts";
import { createUpdater, unavailableUpdater } from "@gram/shell/modules/update";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useUpdateStore } from "@/updates/store";
import { UpdatesSection } from "./updates-section";

const now = new Date(2026, 9, 10, 18, 5).getTime();
const runningSource = "a".repeat(40);
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gram");
  useUpdateStore.setState({ latest: undefined, installingTag: undefined, progress: undefined });
});

/** A synthetic `gh`, signed in as `signedIn` says, whose repository has one newer release. */
const fakeGh = (signedIn: boolean) =>
  vi.fn(async (args: readonly string[]) => {
    const command = args.slice(0, 2).join(" ");
    if (command === "auth status")
      return signedIn
        ? { status: 0, stderr: "", stdout: "" }
        : { status: 1, stderr: "not logged in", stdout: "" };
    if (command === "release list")
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          { tagName: "v0.2.0", isDraft: false },
          { tagName: "v0.1.0", isDraft: false },
        ]),
      };
    if (command === "release view")
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          tagName: "v0.2.0",
          isDraft: false,
          assets: [{ name: "gram_0.2.0_x64-setup.exe" }],
        }),
      };
    return { status: 1, stderr: `unexpected gh ${args.join(" ")}`, stdout: "" };
  });

const windowsUpdater = (gh: ReturnType<typeof fakeGh>) =>
  createUpdater({
    gh,
    repo: "example/gram",
    currentVersion: "0.1.0",
    platform: "win32",
    tempDir: "/synthetic-unused",
    probeSignature: async () => ({ status: 1, stdout: "", stderr: "unused" }),
    warn: () => {},
    readPrefs: async () => ({ channel: "stable" }),
    now: () => now,
  });

it("renders the gh updater's check separately from running identity and pending installation", async () => {
  const gh = fakeGh(true);
  const updater = windowsUpdater(gh);
  let progress: ((value: UpdateProgress) => void) | undefined;
  const request = Promise.withResolvers<{ updating: false; error: string }>();
  const install = vi.fn(() => request.promise);
  const bridge = {
    platform: "win32",
    appBuildInfo: async () => ({ version: "0.1.0", packaged: true, sourceCommit: runningSource }),
    openExternal: vi.fn(async () => true),
    updates: {
      check: async (channel: "stable" | "prerelease") => ({
        ...(await updater.check(channel)),
        checkedAt: now,
      }),
      install,
      onProgress: (callback: (value: UpdateProgress) => void) => {
        progress = callback;
        return () => {};
      },
    },
  } as unknown as DesktopBridge;
  Object.defineProperty(window, "gram", { configurable: true, value: bridge });
  render(<UpdatesSection channel="stable" />);
  expect(await screen.findByText("Running Gram 0.1.0")).toBeTruthy();
  expect(screen.getByText("Source aaaaaaaa")).toBeTruthy();
  expect(gh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(screen.getByRole("status").textContent).toBe("Checking releases");
  expect(await screen.findByText("Update available")).toBeTruthy();
  expect(screen.getByTestId("build-status").textContent).toContain(
    "No download or restart pending.",
  );
  expect(screen.getByTestId("build-status").textContent).toContain("18:05");
  expect(screen.getByTestId("release-notes").textContent).toContain(
    "No release notes were supplied by this update check.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(screen.getByRole("status").textContent).toBe("Preparing update request");
  expect(screen.getByRole("button", { name: "Install" })).toHaveProperty("disabled", true);
  for (const [stage, text] of [
    ["downloading", "Downloading update"],
    ["verifying", "Verifying update"],
    ["installing", "Restarting to install"],
  ] as const) {
    act(() => progress!({ stage, tag: "v0.2.0" }));
    expect(screen.getByRole("status").textContent).toBe(text);
    expect(screen.getByText("Running Gram 0.1.0")).toBeTruthy();
    expect(screen.queryByText("No download or restart pending.")).toBeNull();
  }
  await act(async () =>
    request.resolve({ updating: false, error: "Synthetic download or restart failure" }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Synthetic download or restart failure",
  );
  expect(screen.getByRole("status").textContent).toBe("Update error");
  expect(screen.getByRole("button", { name: "Install" })).toHaveProperty("disabled", false);
});

it("explains absent or development provenance, keeping a same-version check distinct from installed source", async () => {
  Object.defineProperty(window, "gram", {
    configurable: true,
    value: {
      platform: "darwin",
      appBuildInfo: async () => ({ version: "0.1.0-rc.2", packaged: false }),
      updates: { onProgress: () => () => {} },
    },
  });
  useUpdateStore.setState({
    latest: {
      available: false,
      currentVersion: "0.1.0-rc.2",
      canSelfInstall: false,
      channel: "prerelease",
      releases: [],
    },
  });
  render(<UpdatesSection />);
  expect(await screen.findByText(/Development build/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Current for checked channel");
  expect(
    screen.getByText(/Merged changes become available only in a published release/),
  ).toBeTruthy();
  expect(screen.queryByText("installed")).toBeNull();
});

it("does not turn authentication failure into current status or lose the checked channel", async () => {
  const updater = windowsUpdater(fakeGh(false));
  Object.defineProperty(window, "gram", {
    configurable: true,
    value: { platform: "win32", updates: { check: updater.check, onProgress: () => () => {} } },
  });
  render(<UpdatesSection channel="prerelease" />);
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText(/Update checks need the GitHub CLI/)).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("Update error");
  expect(screen.getByText("Source identity unavailable in this build")).toBeTruthy();
});

it("shows an unsigned Mac that it has no in-app updater, with nothing to opt into or install", async () => {
  const updater = unavailableUpdater(
    "0.1.0",
    "Only Developer ID signed builds of Gram update themselves. Install a signed release to get updates.",
  );
  const install = vi.fn();
  Object.defineProperty(window, "gram", {
    configurable: true,
    value: {
      platform: "darwin",
      updates: { check: updater.check, install, onProgress: () => () => {} },
    },
  });
  render(<UpdatesSection channel="stable" onPreferencesChange={vi.fn()} />);
  expect(screen.queryByText("Unsigned private updates")).toBeNull();
  expect(screen.queryByText("Check for updates automatically")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText(/Only Developer ID signed builds of Gram update/)).toBeTruthy();
  expect(screen.getByTestId("build-status").textContent).toContain("Last checked: Stable");
  expect(screen.queryByRole("list", { name: "Releases" })).toBeNull();
  expect(install).not.toHaveBeenCalled();
});
