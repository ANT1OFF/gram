// Which Linux updater an install gets. Only the x64 AppImage and .deb are released: the AppImage
// replaces its own file (electron-updater's check and download, Gram's install), and anything else
// packaged (the .deb) only checks and links to the release. Never Squirrel.Mac: that path is
// macOS's alone, and this returns nothing on any other platform.
import type { AppImageLocation } from "./appimage.ts";

export function linuxUpdateTarget(options: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly packaged: boolean;
  readonly smoke: boolean;
  readonly repo: string | null;
  readonly appImage: AppImageLocation | undefined;
}): "appimage" | "deb" | undefined {
  if (options.platform !== "linux" || options.arch !== "x64") return undefined;
  if (!options.packaged || options.smoke || options.repo === null) return undefined;
  return options.appImage ? "appimage" : "deb";
}
