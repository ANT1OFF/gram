import {
  hostSettingChangedBy,
  InvalidState,
  SettingsRpcs,
  settingsPatchPaths,
  splitSettingsPatch,
  type Palette,
  type SettingsPatch,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ActingPerson, personKey } from "../../embedding/person.ts";
import { EventHub } from "../../events/event-hub.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { isLocalApp } from "../../http/local-app.ts";
import { EMBEDDING_LOCAL_ONLY } from "../../settings/embedding.ts";
import { suppliedPathChangedBy, suppliedRefusal } from "../../settings/supplied.ts";
import { makeSettingsWriter } from "../../settings/writer.ts";
import { logDefects, type Handlers } from "./common.ts";
import { gatewayHandlers } from "./gateway.ts";
import { keybindingsHandlers } from "./keybindings.ts";

/** What a signed-in person's change to one of `HOST_SETTINGS` is refused with. */
export const hostSettingRefusal = (path: ReadonlyArray<string>): string =>
  `${path.join(".")} names a program or folder on the server, so only the app on the server's own machine can change it.`;

/** `settings.*`, `labels.*` and `palettes.*`; `profiles.*` live in `gateway.ts`. */
export const settingsHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  // The path an approved `settings_propose` writes by too.
  const writer = yield* makeSettingsWriter;
  // Absent in handler tests that build no hub.
  const hub = Option.getOrUndefined(yield* Effect.serviceOption(EventHub));

  /**
   * The shared part of `patch` by the one writer, and the caller's own view to their own rows.
   * The connections of a signed-in person are told to read the settings again, and nobody else's
   * are; with no sign-in through a proxy a window's save is announced to no one, as ever.
   */
  const setFor = (patch: SettingsPatch) =>
    Effect.gen(function* () {
      const acting = yield* ActingPerson;
      const person = personKey(acting);
      const { personal, shared } = splitSettingsPatch(patch);
      if (settingsPatchPaths(shared).length > 0) yield* writer.set(shared);
      if (settingsPatchPaths(personal).length === 0) return yield* store.getSettingsFor(person);
      const settings = yield* store.putPersonSettings(person, personal);
      if (acting !== undefined && hub !== undefined)
        yield* hub.publishTo(person, { type: "settings.changed" });
      return settings;
    });

  return {
    // Each person reads the shared settings with their own view over them (`PERSONAL_SETTINGS`).
    "settings.get": () =>
      Effect.gen(function* () {
        return yield* store.getSettingsFor(personKey(yield* ActingPerson));
      }),
    "settings.set": (
      { patch },
      /** The call's transport, which the RPC server always gives; absent in-process. */
      call?: { readonly headers?: Readonly<Record<string, string | undefined>> },
    ) =>
      Effect.gen(function* () {
        const localApp = isLocalApp(call?.headers);
        // The hosted features change who this Gram answers to, so the switch is the local app's: the
        // transport says which connection this is (`isLocalApp`), not anything the caller sent.
        if (patch.experimental?.embedding !== undefined && !localApp)
          return yield* new InvalidState({ message: EMBEDDING_LOCAL_ONLY });
        // A person signed in through a proxy changes no program or folder the server acts on
        // (`HOST_SETTINGS`): the whole patch is refused, so nothing of it is written.
        if (!localApp && (yield* ActingPerson) !== undefined) {
          const host = hostSettingChangedBy(yield* store.getSettings, patch);
          if (host !== undefined)
            return yield* new InvalidState({ message: hostSettingRefusal(host) });
        }
        // What an embedding deployment supplies is read-only here (`settings/supplied.ts`).
        const supplied = yield* suppliedPathChangedBy(store, patch);
        if (supplied !== undefined)
          return yield* new InvalidState({ message: suppliedRefusal(supplied) });
        return yield* setFor(patch);
      }),

    "palettes.list": () => store.listPalettes,
    // `builtin` is server-owned: a client can't mark a palette built-in or clear the flag.
    "palettes.upsert": ({ palette }) =>
      Effect.gen(function* () {
        const existing = (yield* store.listPalettes).find((p) => p.id === palette.id);
        const { builtin, ...rest } = palette;
        void builtin;
        const next: Palette = existing?.builtin === true ? { ...rest, builtin: true } : rest;
        yield* store.upsertPalette(next);
        return next;
      }),
    "palettes.remove": ({ paletteId }) =>
      Effect.gen(function* () {
        const palette = (yield* store.listPalettes).find((p) => p.id === paletteId);
        if (palette?.builtin === true) {
          return yield* new InvalidState({ message: "built-in palettes can't be removed" });
        }
        yield* store.removePalette(paletteId);
      }),

    "people.names": ({ ids }) =>
      Effect.gen(function* () {
        const you = yield* ActingPerson;
        const names = yield* store.personNames(ids);
        return {
          ...(you === undefined ? {} : { you }),
          people: [...names].map(([id, name]) => ({ id, name })),
        };
      }),
    "labels.list": () => store.listLabels,
    "labels.upsert": ({ label }) => store.upsertLabel(label).pipe(Effect.as(label)),
    "labels.remove": ({ labelId }) => store.removeLabel(labelId),
  } satisfies Partial<Handlers>;
});

/** The settings group's handler layer: these, keybindings, and gateway profiles and models. */
export const SettingsHandlersLive = SettingsRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = {
      ...(yield* settingsHandlers),
      ...(yield* keybindingsHandlers),
      ...(yield* gatewayHandlers),
    };
    return SettingsRpcs.of(logDefects(SettingsRpcs, handlers));
  }),
);
