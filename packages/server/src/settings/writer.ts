import {
  applySettingsPatch,
  applySettingsWrites,
  settingsPatchPaths,
  type Settings,
  type SettingsPatch,
  type SettingsWrite,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ServerLog } from "../logging/service.ts";
import { Dreams } from "../orchestration/dreams.ts";
import { ThreadStore, type SettingsAuditEntry } from "../persistence/thread-store.ts";
import { mirrorUpdatePrefs } from "../updates/prerelease-flag.ts";

export interface SettingsWriterOptions {
  /**
   * Tells every window to pull the settings again (`settings.changed`), for a write no window
   * made: a window's own saves already hold what they sent.
   */
  readonly announce?: boolean;
}

/**
 * The one path a settings patch is written by: `settings.set` (the Settings UI) and an approved
 * `settings_propose` alike. After the write it applies what the patch changes beyond the stored
 * value: the log level, the update prefs mirror, automatic Dreams and orchestration's lifecycle.
 */
export const makeSettingsWriter = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const log = yield* ServerLog;
  const config = yield* ServerConfig;
  const mirrorUpdates = mirrorUpdatePrefs(config.dataDir, log.logger);
  // Absent in handler tests that build no orchestration.
  const dreams = Option.getOrUndefined(yield* Effect.serviceOption(Dreams));
  const hub = Option.getOrUndefined(yield* Effect.serviceOption(EventHub));

  /**
   * What a stored change sets off, by the groups it touched: the log level, the update prefs
   * mirror and automatic Dreams; `announce` tells every window.
   */
  const afterCommit = (
    settings: Settings,
    groups: ReadonlySet<string>,
    options: SettingsWriterOptions,
  ) =>
    Effect.gen(function* () {
      yield* log.setLevel(settings.logLevel);
      if (groups.has("updates")) yield* mirrorUpdates(settings.updates);
      if (groups.has("agents") && dreams !== undefined) yield* dreams.automaticConfigurationChanged;
      if (options.announce === true && hub !== undefined) {
        yield* hub.publish({ type: "settings.changed" });
      }
    });

  const set = (patch: SettingsPatch, options: SettingsWriterOptions = {}) =>
    store
      .updateSettings((settings) => applySettingsPatch(settings, patch), settingsPatchPaths(patch))
      .pipe(Effect.tap((settings) => afterCommit(settings, new Set(Object.keys(patch)), options)));

  /**
   * An approved change by chat: `writes` applied only while each field still holds the value the
   * card showed, and its audit in the same transaction, so a stored change always has one. The
   * write and what it sets off aren't interrupted once begun. `undefined` when a field has moved:
   * nothing was written.
   */
  const commit = (
    writes: ReadonlyArray<SettingsWrite>,
    audit: SettingsAuditEntry,
    options: SettingsWriterOptions = {},
  ) =>
    Effect.uninterruptible(
      store
        .updateSettingsAudited(
          (settings) => applySettingsWrites(settings, writes),
          writes.map((write) => write.path),
          audit,
        )
        .pipe(
          Effect.tap((done) =>
            done === undefined
              ? Effect.void
              : afterCommit(done.settings, new Set(writes.map((write) => write.path[0]!)), options),
          ),
        ),
    );

  return { set, commit };
});
