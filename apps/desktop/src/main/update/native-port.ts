import { autoUpdater as squirrel } from "electron";
import { MacUpdater } from "electron-updater";

import { nativeChannelName } from "@gram/shell/modules/update";

import { feedOptions, type ReleaseFeed } from "./native-feed.ts";
import type { ShipIt } from "./native-shipit.ts";
import { createSquirrelFeed } from "./native-squirrel-feed.ts";
import { plainNotes, type NativeUpdaterPort } from "./native-updates.ts";

export function createElectronUpdaterPort(options: {
  readonly feed: ReleaseFeed;
  readonly shipIt: ShipIt;
  readonly log: (level: "info" | "warn", message: string) => void;
}): NativeUpdaterPort {
  const updater = new MacUpdater();
  let staging: Promise<void> | undefined;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
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

    stage(snapshot, version) {
      if (staging) return Promise.reject(new Error("macOS is already preparing an update."));
      staging = (async () => {
        const feed = await createSquirrelFeed(snapshot, version);
        try {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              squirrel.off("update-downloaded", staged);
              squirrel.off("update-not-available", missing);
              squirrel.off("error", failed);
            };
            const staged = () => {
              cleanup();
              resolve();
            };
            const missing = () => {
              cleanup();
              reject(new Error("macOS found nothing to install."));
            };
            const failed = (error: Error) => {
              cleanup();
              reject(error);
            };
            squirrel.once("update-downloaded", staged);
            squirrel.once("update-not-available", missing);
            squirrel.once("error", failed);
            try {
              squirrel.setFeedURL({ url: feed.feedURL, serverType: "default" });
              squirrel.checkForUpdates();
            } catch (error) {
              failed(error instanceof Error ? error : new Error(String(error)));
            }
          });
        } finally {
          staging = undefined;
          await feed.close();
        }
      })();
      return staging;
    },

    pendingInstall: () => options.shipIt.pending(),
    disarm: () => options.shipIt.disarm(),

    quitAndInstall() {
      squirrel.quitAndInstall();
    },
  };
}
