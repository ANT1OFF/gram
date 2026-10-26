import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APP_ICONS, isAppIconId, type AppIconId } from "@gram/contracts";
import { app, BrowserWindow, nativeImage, type NativeImage } from "electron";

/** The icon the app bundle carries; macOS already shows it, so launch leaves the Dock alone. */
const DEFAULT_APP_ICON: AppIconId = APP_ICONS[0];

/** The icon saved in `app-icon.json`, or the default for a missing, unreadable or unknown one. */
export function parseStoredAppIcon(text: string | undefined): AppIconId {
  if (text === undefined) return DEFAULT_APP_ICON;
  try {
    const icon: unknown = Reflect.get(Object(JSON.parse(text)), "icon");
    return isAppIconId(icon) ? icon : DEFAULT_APP_ICON;
  } catch {
    return DEFAULT_APP_ICON;
  }
}

/**
 * Where the PNGs generate-icon.mjs writes to apps/web/public/app-icons are: packaged, in the web
 * root the app ships; in development, in the web app's public folder beside out/main.
 */
export const appIconDir = () =>
  app.isPackaged
    ? join(process.resourcesPath, "web", "app-icons")
    : join(__dirname, "../../../web/public/app-icons");

/**
 * The user's choice of Dock or taskbar icon. macOS swaps the Dock icon; Windows and Linux set every
 * window's icon, so the taskbar follows. Finder, Start and installers keep the bundled default.
 */
export function createAppIcon({ file, dir }: { file: string; dir: string }) {
  let read: string | undefined;
  try {
    read = readFileSync(file, "utf8");
  } catch {
    read = undefined;
  }
  let current = parseStoredAppIcon(read);
  let image: NativeImage | undefined;

  const load = (icon: AppIconId) => {
    const next = nativeImage.createFromPath(join(dir, `${icon}.png`));
    return next.isEmpty() ? undefined : next;
  };
  const apply = () => {
    if (image === undefined) return;
    if (process.platform === "darwin") app.dock?.setIcon(image);
    else for (const win of BrowserWindow.getAllWindows()) win.setIcon(image);
  };

  return {
    get: (): AppIconId => current,
    /** After `ready`, before the first window: applies the saved icon and keeps new windows on it. */
    start() {
      if (current !== DEFAULT_APP_ICON) {
        image = load(current);
        apply();
      }
      if (process.platform !== "darwin")
        app.on("browser-window-created", (_event, win) => {
          if (image) win.setIcon(image);
        });
    },
    set(icon: AppIconId) {
      const next = load(icon);
      if (next === undefined) throw new Error(`no ${icon}.png in ${dir}`);
      current = icon;
      image = next;
      apply();
      try {
        writeFileSync(file, JSON.stringify({ icon }));
      } catch (error) {
        // The next launch opens with the previous icon; nothing else depends on the file.
        process.stderr.write(`app icon: couldn't save the choice: ${String(error)}\n`);
      }
    },
  };
}

export type AppIcon = ReturnType<typeof createAppIcon>;
