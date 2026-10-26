// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KeepInTraySetting, LaunchAtLoginSetting, sendWithDescription } from "./general-section";

describe("sendWithDescription", () => {
  it("names the shortcut once when both composers share it", () => {
    expect(sendWithDescription("⌘↵", "⌘↵")).toContain("(now ⌘↵)");
  });

  it("names each when they were bound apart, and says so when one is off", () => {
    expect(sendWithDescription("⌥S", "⌘↵")).toContain("(now ⌥S in a thread and ⌘↵ on New thread)");
    expect(sendWithDescription("", "⌘↵")).toContain("turned off in a thread");
    expect(sendWithDescription("", "")).toContain("(now turned off)");
  });
});

describe("KeepInTraySetting", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "gram");
  });

  it("shows the shell's setting and saves a change, putting it back if that fails", async () => {
    const set = vi.fn(async (_enabled: boolean) => {});
    Object.assign(window, {
      gram: { keepInTray: { get: async () => false, set, onChange: () => () => {} } },
    });
    render(<KeepInTraySetting />);
    const toggle = await screen.findByRole("switch", { name: "Keep running in tray" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    set.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText(/disk full/)).toBeTruthy();
  });

  it("follows a change made in another window", async () => {
    let notify: ((enabled: boolean) => void) | undefined;
    const unsubscribe = vi.fn();
    Object.assign(window, {
      gram: {
        keepInTray: {
          get: async () => true,
          set: async () => {},
          onChange: (callback: (enabled: boolean) => void) => {
            notify = callback;
            return unsubscribe;
          },
        },
      },
    });
    const { unmount } = render(<KeepInTraySetting />);
    const toggle = await screen.findByRole("switch", { name: "Keep running in tray" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => notify?.(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("shows nothing where the shell keeps no tray", () => {
    const { container } = render(<KeepInTraySetting />);
    expect(container.innerHTML).toBe("");
  });
});

describe("LaunchAtLoginSetting", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "gram");
  });

  const off = { enabled: false, needsApproval: false };

  it("is off by default and saves a change, showing what the OS kept", async () => {
    const set = vi.fn(async (enabled: boolean) => ({ enabled, needsApproval: enabled }));
    const openSettings = vi.fn(async () => true);
    Object.assign(window, { gram: { launchAtLogin: { get: async () => off, set, openSettings } } });
    render(<LaunchAtLoginSetting />);
    const toggle = await screen.findByRole("switch", { name: "Open at login" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith(true);
    // macOS registered it but waits for the user in Login Items.
    const open = await screen.findByRole("button", { name: "Open Login Items" });
    expect(screen.getByText(/Waiting for your approval/)).toBeTruthy();
    fireEvent.click(open);
    expect(openSettings).toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("puts the switch back and says why when the change fails", async () => {
    const set = vi.fn(async () => {
      throw new Error("Operation not permitted");
    });
    Object.assign(window, {
      gram: { launchAtLogin: { get: async () => off, set, openSettings: async () => false } },
    });
    render(<LaunchAtLoginSetting />);
    const toggle = await screen.findByRole("switch", { name: "Open at login" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText(/Operation not permitted/)).toBeTruthy();
  });

  it("shows nothing where the shell can't offer it", async () => {
    const get = vi.fn(async () => null);
    Object.assign(window, {
      gram: { launchAtLogin: { get, set: async () => null, openSettings: async () => false } },
    });
    const { container } = render(<LaunchAtLoginSetting />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
