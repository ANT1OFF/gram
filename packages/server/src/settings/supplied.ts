// Settings supplied from outside: an embedding deployment sets some of the settings for this
// server and they are read-only inside it, whoever asks (the Settings page, a paired phone, an
// agent's `settings_propose`).
//
//   PUT /embed/v1/settings   { "settings": { "updates": { "channel": "stable" }, "logLevel": "info" } }
//   GET /embed/v1/settings   → { "settings": { … } | null }
//
// The body is a settings patch, the shape `settings.set` takes: a section's fields, or a top-level
// key; `null` for a field keeps it cleared. Each `PUT` replaces everything supplied before, and an
// empty patch supplies nothing. What is supplied is kept in the store beside the settings and
// applied over every read and write of them (`ThreadStore.putSuppliedSettings`), so it holds
// through a restart. A setting no longer supplied keeps the value it last had, and can be changed
// inside again.
//
// The hosted features setting itself is never supplied this way: it is what turns this on.

import { embeddingOn, SettingsPatch, settingsPatchPaths } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { answer, EmbedInbound, refusal } from "../embedding/inbound.ts";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { makeSettingsWriter } from "./writer.ts";

/** What a change to a supplied setting is refused with. */
export const suppliedRefusal = (path: ReadonlyArray<string>): string =>
  `${path.join(".")} is set by the service that runs this Gram and can't be changed here.`;

/** `value` with every object's keys in order, so two spellings of one value compare equal. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, each]) => [key, ordered(each)]),
        )
      : value;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

const valueAt = (root: unknown, path: ReadonlyArray<string>): unknown => {
  let value = root;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

/** Whether `path` is, holds, or sits inside `locked`. */
const overlaps = (path: ReadonlyArray<string>, locked: ReadonlyArray<string>): boolean =>
  path.slice(0, locked.length).every((key, index) => key === locked[index]) ||
  locked.slice(0, path.length).every((key, index) => key === path[index]);

/** What is supplied now, while the hosted features are on. */
const suppliedNow = (store: Pick<ThreadStoreShape, "getSettings" | "getSuppliedSettings">) =>
  Effect.gen(function* () {
    const patch = yield* store.getSuppliedSettings;
    if (patch === undefined || !embeddingOn(yield* store.getSettings)) return undefined;
    return patch;
  });

/**
 * The first path of `patch` that would change a supplied setting, if any. A patch that repeats
 * the supplied value passes: a window saving a whole section changes nothing by it.
 */
export const suppliedPathChangedBy = (
  store: Pick<ThreadStoreShape, "getSettings" | "getSuppliedSettings">,
  patch: SettingsPatch,
): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.gen(function* () {
    const supplied = yield* suppliedNow(store);
    if (supplied === undefined) return undefined;
    const locked = settingsPatchPaths(supplied);
    return settingsPatchPaths(patch).find((path) =>
      locked.some(
        (held) =>
          overlaps(path, held) &&
          !same(valueAt(patch, held) ?? null, valueAt(supplied, held) ?? null),
      ),
    );
  });

/** The first of `paths` (the fields an approved proposal writes) that is supplied, if any. */
export const suppliedPathAmong = (
  store: Pick<ThreadStoreShape, "getSettings" | "getSuppliedSettings">,
  paths: ReadonlyArray<ReadonlyArray<string>>,
): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.gen(function* () {
    const supplied = yield* suppliedNow(store);
    if (supplied === undefined) return undefined;
    const locked = settingsPatchPaths(supplied);
    return paths.find((path) => locked.some((held) => overlaps(path, held)));
  });

const decodePatch = Schema.decodeUnknownEffect(SettingsPatch);

/** Serves `settings` on the inbound API; provides nothing. */
export const SuppliedSettingsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbound = yield* EmbedInbound;
    const store = yield* ThreadStore;
    const writer = yield* makeSettingsWriter;

    yield* inbound.route("GET", "settings", () =>
      Effect.map(store.getSuppliedSettings, (patch) => answer({ settings: patch ?? null })),
    );
    yield* inbound.route("PUT", "settings", (body) =>
      Effect.gen(function* () {
        const given = body?.["settings"];
        if (typeof given !== "object" || given === null || Array.isArray(given)) {
          return refusal(400, "`settings` is a settings patch");
        }
        const patch = yield* decodePatch(given).pipe(Effect.catch(() => Effect.succeed(undefined)));
        // The decode's own message can quote the value it refused, which isn't ours to echo.
        if (patch === undefined) return refusal(400, "`settings` isn't a settings patch");
        if (patch.experimental?.embedding !== undefined) {
          return refusal(400, "experimental.embedding can't be supplied");
        }
        const paths = settingsPatchPaths(patch);
        yield* store.putSuppliedSettings(paths.length === 0 ? undefined : patch);
        // The same path a window's save takes, for what a change sets off beyond the stored value
        // (the log level, the update prefs); every window is told to read the settings again.
        yield* writer.set(patch, { announce: true });
        yield* Effect.logInfo("settings supplied").pipe(
          Effect.annotateLogs({ paths: paths.map((path) => path.join(".")).join(",") }),
        );
        // What the caller reads to see a setting this build doesn't know was left out.
        return answer({ supplied: paths.map((path) => path.join(".")).toSorted() });
      }),
    );
  }),
);
