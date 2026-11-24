import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APP_ICONS, type AppIconId } from "@gram/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { app, nativeImage, type NativeImage } from "electron";
import { appWindows } from "@gram/shell/electron";

const DEFAULT_APP_ICON: AppIconId = APP_ICONS[0];

/** The icon saved in `app-icon.json`, or the default for a missing, unreadable or unknown one. */
export function parseStoredAppIcon(text: string | undefined): AppIconId {
  if (text === undefined) return DEFAULT_APP_ICON;
  return Option.match(decodeStoredAppIcon(text), {
    onNone: () => DEFAULT_APP_ICON,
    onSome: ({ icon }) => icon,
  });
}

const decodeStoredAppIcon = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ icon: Schema.Literals(APP_ICONS) })),
);

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
    else for (const win of appWindows()) win.setIcon(image);
  };

  return {
    get: (): AppIconId => current,
    /** After `ready`, before the first window: applies the saved icon and keeps new windows on it. */
    start() {
      if (current !== DEFAULT_APP_ICON || process.platform === "linux") {
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
        process.stderr.write(`app icon: couldn't save the choice: ${String(error)}\n`);
      }
    },
  };
}

export type AppIcon = ReturnType<typeof createAppIcon>;
