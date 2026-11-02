// electron-updater's AppImage updater behind `NativeUpdaterPort`, for the Linux AppImage. It checks
// the feed and downloads the AppImage, checking the manifest's SHA-512. Installing is Gram's own:
// electron-updater's would unlink the running AppImage and move its shared cache file into place,
// so instead the verified snapshot is written beside the AppImage and renamed over it
// (`installAppImage`), after the stop fence. Nothing here touches Squirrel.Mac or ShipIt: no
// install is ever pending outside Gram, and the restart is Electron's own relaunch.
import { AppImageUpdater } from "electron-updater";

import { nativeChannelName } from "@gram/shell/modules/update";

import { installAppImage } from "./appimage.ts";
import { feedOptions, type ReleaseFeed } from "./native-feed.ts";
import { plainNotes, type NativeUpdaterPort } from "./native-updates.ts";

export function createAppImageUpdaterPort(options: {
  readonly feed: ReleaseFeed;
  /** The running AppImage's file, which an update replaces. */
  readonly appImage: string;
  /** Starts `appImage` once this process has exited, then quits (`app.relaunch`, `app.quit`). */
  readonly relaunch: (appImage: string) => void;
  readonly log: (level: "info" | "warn", message: string) => void;
  /** The updater; tests give a synthetic one. */
  readonly updater?: Pick<
    AppImageUpdater,
    | "autoDownload"
    | "autoInstallOnAppQuit"
    | "autoRunAppAfterInstall"
    | "disableDifferentialDownload"
    | "fullChangelog"
    | "logger"
    | "channel"
    | "allowPrerelease"
    | "allowDowngrade"
    | "setFeedURL"
    | "checkForUpdates"
    | "downloadUpdate"
    | "on"
    | "off"
  >;
  readonly install?: typeof installAppImage;
}): NativeUpdaterPort {
  const updater = options.updater ?? new AppImageUpdater();
  const install = options.install ?? installAppImage;
  let staging: Promise<void> | undefined;
  // Nothing happens unasked: no download on a check, and electron-updater never installs on quit;
  // its own install is never called.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
  // Every download is the whole AppImage: no embedded block map is trusted.
  updater.disableDifferentialDownload = true;
  updater.fullChangelog = false;
  updater.logger = {
    info: (message: unknown) => options.log("info", `electron-updater: ${String(message)}`),
    warn: (message: unknown) => options.log("warn", `electron-updater: ${String(message)}`),
    error: (message: unknown) => options.log("warn", `electron-updater: ${String(message)}`),
  };

  return {
    useFeed(channel) {
      updater.setFeedURL(feedOptions(options.feed, channel));
      // Setting the channel allows downgrades; nothing here ever does.
      updater.channel = nativeChannelName(channel);
      updater.allowPrerelease = channel === "prerelease";
      updater.allowDowngrade = false;
    },

    async check() {
      const result = await updater.checkForUpdates();
      if (!result) throw new Error("Electron's updater is off in this build.");
      if (!result.isUpdateAvailable) return null;
      const info = result.updateInfo;
      return {
        version: info.version,
        notes: plainNotes(info.releaseNotes),
        date: typeof info.releaseDate === "string" && info.releaseDate ? info.releaseDate : null,
      };
    },

    async download(onPercent) {
      const progress = (info: { percent: number }) => onPercent(info.percent);
      updater.on("download-progress", progress);
      try {
        const [file] = await updater.downloadUpdate();
        if (!file) throw new Error("The download finished without a file.");
        return file;
      } finally {
        updater.off("download-progress", progress);
      }
    },

    stage(snapshot) {
      if (staging) return Promise.reject(new Error("Gram is already writing an update."));
      staging = install(snapshot, options.appImage).finally(() => {
        staging = undefined;
      });
      return staging;
    },

    // Gram's own rename is the whole install: nothing waits outside it.
    pendingInstall: async () => false,
    disarm: async () => true,

    quitAndInstall() {
      options.relaunch(options.appImage);
    },
  };
}
