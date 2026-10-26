// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { LIGHTS_WIDTH, lightsInset, useWindowLights, watchWindowLights } from "./window-lights";

const root = () => document.documentElement.style.getPropertyValue("--window-lights-inset");

/** A fake shell whose zoom and full screen the test moves. */
const shell = (platform: string, zoom = 1, fullScreen = false) => {
  const listeners = new Set<(next: boolean) => void>();
  const bridge = {
    platform,
    zoom,
    zoomFactor: () => bridge.zoom,
    fullScreen: {
      get: async () => fullScreen,
      onChange: (callback: (next: boolean) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    setFullScreen: (next: boolean) => {
      for (const listener of listeners) listener(next);
    },
  };
  return bridge;
};

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("lightsInset", () => {
  it("keeps the window buttons' width in CSS pixels at the page's zoom, on macOS out of full screen", () => {
    expect(lightsInset(true, false, 1)).toBe(LIGHTS_WIDTH);
    // Zoomed out, a CSS pixel is smaller than a window point, so more of them clear the buttons.
    expect(lightsInset(true, false, 0.75)).toBe(Math.ceil(LIGHTS_WIDTH / 0.75));
    expect(lightsInset(true, false, 1.5)).toBe(Math.ceil(LIGHTS_WIDTH / 1.5));
    expect(lightsInset(true, true, 0.75)).toBe(0);
    expect(lightsInset(false, false, 1)).toBe(0);
  });
});

describe("watchWindowLights", () => {
  it("follows the window's zoom and full screen on macOS", async () => {
    const bridge = shell("darwin", 0.75);
    stop = watchWindowLights(bridge);
    expect(root()).toBe(`${Math.ceil(LIGHTS_WIDTH / 0.75)}px`);

    bridge.zoom = 1;
    window.dispatchEvent(new Event("resize"));
    expect(root()).toBe(`${LIGHTS_WIDTH}px`);
    expect(useWindowLights.getState().inset).toBe(LIGHTS_WIDTH);

    bridge.setFullScreen(true);
    expect(root()).toBe("0px");
    expect(useWindowLights.getState().inset).toBe(0);
    // The startup answer, older than the change, doesn't undo it.
    await Promise.resolve();
    expect(root()).toBe("0px");

    bridge.setFullScreen(false);
    expect(root()).toBe(`${LIGHTS_WIDTH}px`);
  });

  it("starts without the room when the window opens full screen", async () => {
    stop = watchWindowLights(shell("darwin", 1, true));
    await Promise.resolve();
    expect(root()).toBe("0px");
  });

  it("keeps no room on other platforms", () => {
    stop = watchWindowLights(shell("win32"));
    expect(root()).toBe("0px");
    expect(useWindowLights.getState().inset).toBe(0);
  });
});
