import {
  HOST_PROGRAM_SETTINGS,
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
import {
  lockedPathChangedBy,
  suppliedPathChangedBy,
  suppliedRefusal,
} from "../../settings/supplied.ts";
import { FrontedSignIn } from "../actor-guard.ts";
import { makeSettingsWriter } from "../../settings/writer.ts";
import { logDefects, type Handlers } from "./common.ts";
import { gatewayHandlers } from "./gateway.ts";
import { keybindingsHandlers } from "./keybindings.ts";

/**
 * What a person's change to one of `HOST_PROGRAM_SETTINGS` is refused with on a server people sign
 * in to through a proxy.
 */
export const hostProgramRefusal = (path: ReadonlyArray<string>): string =>
  `${path.join(".")} chooses a program or folder on the machine this Gram runs on, so only the service that runs it changes it.`;

/** `settings.*`, `labels.*` and `palettes.*`; `profiles.*` live in `gateway.ts`. */
export const settingsHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  // The path an approved `settings_propose` writes by too.
  const writer = yield* makeSettingsWriter;
  // Absent in handler tests that build no hub.
  const hub = Option.getOrUndefined(yield* Effect.serviceOption(EventHub));
  // Absent in handler tests that serve no sign-in: the launch token, as on the desktop.
  const fronted = Option.getOrUndefined(yield* Effect.serviceOption(FrontedSignIn));

  /**
   * The first path of `patch` that would change a program or folder the server acts with, while
   * people sign in through a proxy and the call isn't the local app's. Everyone signed in shares
   * this machine's user, so none of them picks what it runs; the local app and the deployment
   * (`settings/supplied.ts`) still do.
   */
  const hostProgramChangedBy = (patch: SettingsPatch, localApp: boolean) =>
    Effect.gen(function* () {
      if (localApp || fronted === undefined || !(yield* fronted.active)) return undefined;
      return lockedPathChangedBy(patch, yield* store.getSettings, HOST_PROGRAM_SETTINGS);
    });

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
      // The hosted features change who this Gram answers to, so the switch is the local app's: the
      // transport says which connection this is (`isLocalApp`), not anything the caller sent.
      patch.experimental?.embedding !== undefined && !isLocalApp(call?.headers)
        ? Effect.fail(new InvalidState({ message: EMBEDDING_LOCAL_ONLY }))
        : Effect.gen(function* () {
            // Checked whole before anything is written, so a refused patch changes nothing.
            const hostPath = yield* hostProgramChangedBy(patch, isLocalApp(call?.headers));
            if (hostPath !== undefined)
              return yield* new InvalidState({ message: hostProgramRefusal(hostPath) });
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
