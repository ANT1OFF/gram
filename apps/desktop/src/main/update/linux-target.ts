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
