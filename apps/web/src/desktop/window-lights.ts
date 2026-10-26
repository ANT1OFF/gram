import type { DesktopBridge } from "@gram/contracts";
import { create } from "zustand";

/**
 * How far macOS's window buttons reach from the window's left edge, the gap after them included,
 * in window points. The `hiddenInset` title bar draws them at this size at any page zoom.
 */
export const LIGHTS_WIDTH = 80;

/**
 * The room kept for macOS's window buttons at the window's top left, in CSS pixels: 0 where they
 * don't show (another platform, a browser, full screen), and wider as the page zooms out.
 */
export const lightsInset = (mac: boolean, fullScreen: boolean, zoom: number): number =>
  mac && !fullScreen ? Math.ceil(LIGHTS_WIDTH / (zoom > 0 ? zoom : 1)) : 0;

/** `lightsInset` for this window, which `watchWindowLights` keeps current. */
export const useWindowLights = create<{ inset: number }>(() => ({ inset: 0 }));

/**
 * Keeps `useWindowLights` and the root's `--window-lights-inset` current as this window zooms and
 * enters or leaves full screen. Returns the cleanup.
 */
export function watchWindowLights(
  bridge: Pick<DesktopBridge, "platform" | "zoomFactor" | "fullScreen">,
  root: HTMLElement = document.documentElement,
): () => void {
  const mac = bridge.platform === "darwin";
  let fullScreen: boolean | undefined;
  const sync = () => {
    const inset = lightsInset(mac, fullScreen === true, bridge.zoomFactor?.() ?? 1);
    root.style.setProperty("--window-lights-inset", `${inset}px`);
    useWindowLights.setState({ inset });
  };
  sync();
  if (!mac) return () => root.style.removeProperty("--window-lights-inset");
  // Zoom changes the viewport's width in CSS pixels, so a zoom step comes as a resize.
  window.addEventListener("resize", sync);
  const off = bridge.fullScreen?.onChange((next) => {
    fullScreen = next;
    sync();
  });
  bridge.fullScreen?.get().then(
    (now) => {
      // A change that came first is newer than this answer.
      if (fullScreen !== undefined) return;
      fullScreen = now;
      sync();
    },
    () => {},
  );
  return () => {
    window.removeEventListener("resize", sync);
    off?.();
    root.style.removeProperty("--window-lights-inset");
  };
}
