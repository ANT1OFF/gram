import { homedir } from "node:os";

import {
  AgentUnavailable,
  GatewayError,
  NotFound,
  customModelsOf,
  gatewayAgentModel,
  gatewayModelUsable,
  GATEWAY_UNLISTED_WARNING,
  withCustomModels,
  type AgentKind,
  type AgentModel,
  type GatewayModel,
  type GatewayProfile,
  type ProfileId,
  type ServerEvent,
  type SetKeyResult,
  type SlashCommand,
  type ThreadId,
  type VaultInfo,
} from "@gram/contracts";
import type { AgentHost } from "@gram/agents";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { EventHub, isThreadRemoved } from "../../events/event-hub.ts";
import { ComposerPresence } from "../../runtime/composer-presence.ts";
import { modelSuggestions, threadModelSuggestions } from "../../gateway/model-suggestions.ts";
import { discoverModels, type Fetcher } from "../../gateway/discovery.ts";
import {
  makeBridgeVault,
  makeMemoryVault,
  profileKeyRef,
  type KeyVault,
  type VaultPort,
} from "../../gateway/key-vault.ts";
import { codexModelFor } from "../../gateway/codex-home.ts";
import { readOpenCodeKey, seedProfiles } from "../../gateway/seed.ts";
import { runTitleWatcher, schedulerTitles, titlePhase } from "../../gateway/titles.ts";
import { HelperScheduler } from "../../helper/scheduler.ts";
import { GatewayCredentials } from "../../gateway/credentials.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { AgentHosts } from "../../runtime/agent-hosts.ts";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

export interface GatewayDeps {
  readonly store: ThreadStore["Service"];
  readonly hosts: AgentHosts["Service"];
  readonly vault: KeyVault;
  readonly fetcher: Fetcher;
  /** Where OpenCode's config and `auth.json` live. */
  readonly home: string;
  /** Publishes `profiles.changed`. */
  readonly publish?: (event: ServerEvent) => Effect.Effect<void>;
  /**
   * Applies a changed or removed key, or a changed model list, to the agents' servers and the
   * sessions on that profile.
   */
  readonly onKeyChanged?: (profileId: ProfileId) => Effect.Effect<void>;
  /** Names the vault's store; defaults to this process's platform. */
  readonly platform?: NodeJS.Platform;
  /** The model the user's own Codex config uses on a base URL, Codex's default on that profile. */
  readonly codexModel?: (baseURL: string) => Effect.Effect<string | undefined>;
}

/**
 * What protects the vault's keys, for Settings: `backend` is the one `safeStorage` picked on Linux.
 * A memory vault says its keys aren't saved.
 */
export const vaultInfo = (
  kind: KeyVault["kind"],
  platform: NodeJS.Platform,
  backend?: string,
): VaultInfo => {
  if (kind === "memory") {
    return {
      kind: "memory",
      persisted: false,
      label: "not saved; the key is kept only while the server runs",
    };
  }
  switch (platform) {
    case "darwin":
      return { kind: "keychain", persisted: true, label: "the macOS Keychain" };
    case "win32":
      // DPAPI ciphertext in the app's data folder (`gateway-keys.json`), not Credential Manager.
      return {
        kind: "dpapi",
        persisted: true,
        label: "a file encrypted with Windows data protection for your account",
      };
    default:
      // With no keyring, `safeStorage` falls back to `basic_text`, which doesn't encrypt.
      return backend === "basic_text"
        ? {
            kind: "unencrypted",
            persisted: true,
            label: "an unencrypted file, as no system keyring is available",
          }
        : { kind: "libsecret", persisted: true, label: "the system keyring" };
  }
};

/** Control characters, line breaks included, which would break a Windows `cmd.exe` shim call. */
const hasControlCharacter = (text: string) =>
  [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

const toAgentModel = (model: GatewayModel, agent: AgentKind, index: number): AgentModel => ({
  ...gatewayAgentModel(model, agent),
  ...(index === 0 ? { isDefault: true } : {}),
});

/**
 * A profile's models for the model picker, the usable ones (`gatewayModelUsable`), the first one
 * the default. With `preferred` (for Codex, the model the user's own Codex config uses on this
 * gateway), that one is the default instead, kept whatever the gateway says of it, and listed first
 * when discovery didn't find it. A model in `kept` (one the user added in Settings) stays too, with
 * the efforts the gateway gives it rather than the custom entry's guess.
 */
export const profileModels = (
  discovered: ReadonlyArray<GatewayModel>,
  agent: AgentKind,
  preferred?: string,
  kept: ReadonlySet<string> = new Set(),
): Array<AgentModel> => {
  const models = discovered.filter(
    (model) => model.id === preferred || kept.has(model.id) || gatewayModelUsable(model),
  );
  if (preferred === undefined)
    return models.map((model, index) => toAgentModel(model, agent, index));
  const listed = models.some((model) => model.id === preferred)
    ? models
    : [{ id: preferred, name: preferred }, ...models];
  return listed.map((model) => ({
    ...toAgentModel(model, agent, -1),
    ...(model.id === preferred ? { isDefault: true } : {}),
  }));
};

const AGENT_NAMES: Readonly<Record<AgentKind, string>> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok Build",
};

/**
 * `models` with a warning on each one the profile's gateway doesn't list (a custom model, or Codex's
 * own configured one), and else on each the agent says it doesn't know through the profile. Either
 * may still run, so the picker warns rather than hides it.
 */
export const warnUnknown = (
  host: Pick<AgentHost, "kind" | "knownModels">,
  profile: Pick<GatewayProfile, "id" | "models">,
  models: ReadonlyArray<AgentModel>,
): Effect.Effect<ReadonlyArray<AgentModel>> =>
  Effect.gen(function* () {
    const discovered = new Set(profile.models.map((model) => model.id));
    const known = host.knownModels === undefined ? undefined : yield* host.knownModels(profile.id);
    return models.map((model): AgentModel => {
      const warning = !discovered.has(model.id)
        ? GATEWAY_UNLISTED_WARNING
        : known !== undefined && !known.has(model.id)
          ? `${AGENT_NAMES[host.kind]} doesn't know this model; it runs on generic settings`
          : undefined;
      return warning === undefined ? model : { ...model, warning };
    });
  });

const withoutDefault = ({ default: _default, ...profile }: GatewayProfile): GatewayProfile =>
  profile;

/** `profiles.*` and `models.list` over injectable dependencies. */
export const makeGateway = ({
  store,
  hosts,
  vault,
  fetcher,
  home,
  publish = () => Effect.void,
  onKeyChanged = () => Effect.void,
  platform = process.platform,
  codexModel = () => Effect.succeed(undefined),
}: GatewayDeps) => {
  const changed = publish({ type: "profiles.changed" });

  const findProfile = (profileId: ProfileId) =>
    store.listProfiles.pipe(
      Effect.flatMap((profiles) => {
        const profile = profiles.find((p) => p.id === profileId);
        return profile === undefined
          ? Effect.fail(new NotFound({ entity: "profile", id: profileId }))
          : Effect.succeed(profile);
      }),
    );

  /** The stored key, if any; `keyRef` is `""` until a key is set. */
  const keyFor = (profile: GatewayProfile) =>
    profile.keyRef === ""
      ? Effect.succeed(Option.none<Redacted.Redacted<string>>())
      : vault.get(profile.keyRef);

  const storeKey = (profile: GatewayProfile, key: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const value = Redacted.value(key).trim();
      const ref = profileKeyRef(profile.id);
      if (value === "") {
        yield* vault.remove(ref);
        yield* store.upsertProfile({ ...profile, keyRef: "" });
      } else {
        yield* vault.set(ref, Redacted.make(value));
        yield* store.upsertProfile({ ...profile, keyRef: ref });
      }
    }).pipe(
      // Not the vault's own reason: it may quote what it was handed.
      Effect.catchTag("VaultError", () =>
        Effect.fail(
          new GatewayError({
            profileId: profile.id,
            message:
              "Couldn't update the stored key: the key store refused it. Try again, or restart Gram.",
          }),
        ),
      ),
    );

  /**
   * After a key is stored or cleared: a saved key discovers models (a failure is reported, not
   * thrown) and makes the profile the default when none is; either way live servers and sessions
   * pick the change up, and clients are told.
   */
  const afterKeyChange = (profileId: ProfileId, key: Option.Option<Redacted.Redacted<string>>) =>
    Effect.gen(function* () {
      let result: SetKeyResult = {};
      if (Option.isSome(key)) {
        const profile = yield* findProfile(profileId);
        result = yield* discoverModels(profile, key.value, fetcher).pipe(
          Effect.flatMap((models) =>
            store
              .upsertProfile({ ...profile, models })
              .pipe(Effect.as({ discovered: models.length })),
          ),
          Effect.catch((error) => Effect.succeed({ discoveryError: error.message })),
        );
        const profiles = yield* store.listProfiles;
        const current = profiles.find((p) => p.id === profileId);
        if (current !== undefined && !profiles.some((p) => p.default === true)) {
          yield* store.upsertProfile({ ...current, default: true });
          result = { ...result, madeDefault: true };
        }
      }
      yield* onKeyChanged(profileId);
      yield* changed;
      return result;
    });

  /** Imports OpenCode's key for the provider on the profile's base URL. Only after user consent. */
  const importOpenCodeKey = (profileId: ProfileId) =>
    Effect.gen(function* () {
      const profile = yield* findProfile(profileId);
      const key = yield* readOpenCodeKey(home, profile.baseURL);
      if (Option.isNone(key)) return { imported: false };
      yield* storeKey(profile, key.value);
      yield* afterKeyChange(profileId, key);
      return { imported: true };
    });

  /** A profile and its key for an agent adapter; the key stays redacted until the child env. */
  const credentials = (profileId: ProfileId, agent: AgentKind) =>
    findProfile(profileId).pipe(
      Effect.mapError(
        () =>
          new AgentUnavailable({ agent, message: `Gateway profile ${profileId} doesn't exist.` }),
      ),
      Effect.flatMap((profile) =>
        keyFor(profile).pipe(
          Effect.mapError(
            (error) =>
              new AgentUnavailable({
                agent,
                message: `Couldn't read the key for ${profile.name}: ${error.message}`,
              }),
          ),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new AgentUnavailable({ agent, message: `Set a key for ${profile.name} first.` }),
                ),
              onSome: (key) => Effect.succeed({ profile, key }),
            }),
          ),
        ),
      ),
    );

  const handlers = {
    "profiles.list": () => store.listProfiles,

    // `keyRef` is server-owned: it names the stored key, and a client can't point it elsewhere.
    "profiles.upsert": ({ profile }) =>
      Effect.gen(function* () {
        const invalid = hasControlCharacter(profile.name)
          ? "name"
          : hasControlCharacter(profile.baseURL)
            ? "base URL"
            : hasControlCharacter(profile.helperModel ?? "")
              ? "helper model"
              : undefined;
        if (invalid !== undefined) {
          return yield* Effect.fail(
            new GatewayError({
              profileId: profile.id,
              message: `A gateway's ${invalid} can't contain line breaks or other control characters.`,
            }),
          );
        }
        const profiles = yield* store.listProfiles;
        const existing = profiles.find((p) => p.id === profile.id);
        // The first profile, or any profile while none is the default, becomes the default.
        const noOtherDefault = !profiles.some((p) => p.id !== profile.id && p.default === true);
        const next: GatewayProfile = {
          ...withoutDefault(profile),
          keyRef: existing?.keyRef ?? "",
          ...(profile.default === true || noOtherDefault ? { default: true } : {}),
        };
        if (next.default === true) {
          for (const other of profiles) {
            if (other.id !== next.id && other.default === true)
              yield* store.upsertProfile(withoutDefault(other));
          }
        }
        yield* store.upsertProfile(next);
        yield* changed;
        return next;
      }),

    "profiles.setKey": ({ profileId, key }) =>
      Effect.gen(function* () {
        const profile = yield* findProfile(profileId);
        yield* storeKey(profile, key);
        const value = Redacted.value(key).trim();
        return yield* afterKeyChange(
          profileId,
          value === "" ? Option.none() : Option.some(Redacted.make(value)),
        );
      }),

    "profiles.vaultInfo": () =>
      vault.backend.pipe(
        Effect.catch(() => Effect.succeed(undefined)),
        Effect.map((backend) => vaultInfo(vault.kind, platform, backend)),
      ),

    // Only while none exist, so it never duplicates or overrides profiles the user edited.
    "profiles.seed": () =>
      Effect.gen(function* () {
        if ((yield* store.listProfiles).length > 0) return { added: 0 };
        const seeded = yield* seedProfiles(home);
        for (const profile of seeded) yield* store.upsertProfile(profile);
        if (seeded.length > 0) yield* changed;
        return { added: seeded.length };
      }),

    "profiles.remove": ({ profileId }) =>
      store.removeProfile(profileId).pipe(
        Effect.tap(() => vault.remove(profileKeyRef(profileId)).pipe(Effect.ignore)),
        Effect.tap(() => onKeyChanged(profileId)),
        Effect.tap(() => changed),
      ),

    // Reads OpenCode's `auth.json` only here, after the user consented in the UI.
    "profiles.importKey": ({ profileId }) => importOpenCodeKey(profileId),

    "profiles.discoverModels": ({ profileId }) =>
      Effect.gen(function* () {
        const profile = yield* findProfile(profileId);
        const key = yield* keyFor(profile).pipe(
          Effect.mapError(
            (error) =>
              new GatewayError({ profileId, message: `Couldn't read the key: ${error.message}` }),
          ),
        );
        if (Option.isNone(key)) {
          return yield* new GatewayError({
            profileId,
            message: `Set a key for ${profile.name} first`,
          });
        }
        const models = yield* discoverModels(profile, key.value, fetcher);
        yield* store.upsertProfile({ ...profile, models });
        // Codex reads a profile's model catalog as its server starts, so a changed list
        // retires the servers as a changed key does.
        if (JSON.stringify(models) !== JSON.stringify(profile.models)) {
          yield* onKeyChanged(profileId);
        }
        yield* changed;
        return models;
      }),

    "models.suggestions": () =>
      Effect.all([modelSuggestions(home), store.listThreads]).pipe(
        Effect.map(([configured, threads]) => ({
          suggestions: [...configured, ...threadModelSuggestions(threads)],
        })),
      ),

    // The agent's adapter must be registered even when the models come from a gateway profile.
    "models.list": ({ agent, profileId }) =>
      Effect.gen(function* () {
        const host = yield* hosts.get(agent);
        if (agent === "grok")
          return { models: yield* host.listModels(profileId === undefined ? {} : { profileId }) };
        // The user's own models follow either list: an id is the same id through a gateway.
        const custom = customModelsOf(yield* store.getSettings, agent);
        if (profileId === undefined) {
          return { models: withCustomModels(yield* host.listModels(), custom) };
        }
        const profile = (yield* store.listProfiles).find((p) => p.id === profileId);
        if (profile === undefined) {
          return yield* new AgentUnavailable({ agent, message: "Unknown gateway profile" });
        }
        const preferred = agent === "codex" ? yield* codexModel(profile.baseURL) : undefined;
        const added = new Set(custom.map((model) => model.id));
        const listed = withCustomModels(
          profileModels(profile.models, agent, preferred, added),
          custom,
        );
        return { models: yield* warnUnknown(host, profile, listed) };
      }),
  } satisfies Partial<Handlers>;

  return { handlers, importOpenCodeKey, keyFor, credentials };
};

type ThreadStatusEvent = Extract<ServerEvent, { type: "thread.status" }>;

/** Gateway profiles, keys, discovery, helper-LLM titles and the helper scheduler's RPCs. */
export const gatewayHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const hosts = yield* AgentHosts;
  const hub = yield* EventHub;
  const runtimes = yield* ThreadRuntimes;
  const home = homedir();

  // Under Electron the desktop app holds keys in safeStorage; outside it (`pnpm dev`) keys live only
  // in memory, and Settings says they aren't saved.
  const parentPort = (process as { parentPort?: VaultPort }).parentPort;
  const vault = parentPort === undefined ? makeMemoryVault() : makeBridgeVault(parentPort);

  /** Retires the agents' per-profile servers, then reopens sessions on the profile once idle. */
  const onKeyChanged = (profileId: ProfileId) =>
    Effect.gen(function* () {
      for (const kind of ["codex", "claude"] as const) {
        const host = yield* hosts.get(kind).pipe(Effect.option);
        if (Option.isSome(host) && host.value.invalidateProfile !== undefined) {
          yield* host.value.invalidateProfile(profileId);
        }
      }
      for (const summary of yield* runtimes.snapshot) {
        if (summary.thread.model.profileId === profileId) {
          yield* runtimes.reloadSession(summary.thread.id).pipe(Effect.ignore);
        }
      }
    });

  const gateway = makeGateway({
    store,
    hosts,
    vault,
    fetcher: (url, init) => fetch(url, init),
    home,
    publish: (event) => hub.publish(event),
    onKeyChanged,
    codexModel: codexModelFor(home),
  });

  // Agent adapters are built before this layer; hand them the profile + key lookup now.
  const credentials = yield* Effect.serviceOption(GatewayCredentials);
  if (Option.isSome(credentials)) yield* credentials.value.install(gateway.credentials);

  const helper = schedulerTitles(yield* HelperScheduler);
  // Kept from the same stream the moments come from, so a session's commands are on record by the
  // time a status after its `thread.identity` is looked at.
  const sessionCommands = new Map<ThreadId, ReadonlyArray<SlashCommand>>();
  yield* runTitleWatcher({
    helper,
    moments: Stream.merge(
      hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event.type === "thread.identity") {
              sessionCommands.set(event.threadId, event.identity.commands);
            } else if (event.type === "thread.removed") {
              sessionCommands.delete(event.threadId);
            }
          }),
        ),
        Stream.filter((event): event is ThreadStatusEvent => event.type === "thread.status"),
        Stream.flatMap((event) => {
          const phase = titlePhase(event.status);
          return phase === undefined
            ? Stream.empty
            : Stream.make({ threadId: event.threadId, phase });
        }),
      ),
      // Every removal, none dropped, so the watcher lets go of each thread it kept.
      hub
        .internalEvents(isThreadRemoved, "thread titles")
        .pipe(Stream.map((event) => ({ threadId: event.threadId, phase: "removed" as const }))),
    ),
    getThread: (threadId) => store.getThread(threadId),
    turnCount: (threadId) => store.listTurns(threadId).pipe(Effect.map((turns) => turns.length)),
    messages: (threadId) => store.listMessages(threadId),
    commands: (threadId) => Effect.sync(() => sessionCommands.get(threadId)),
    updateThread: (threadId, f) => runtimes.updateThread(threadId, f),
  }).pipe(Effect.forkScoped);

  const scheduler = yield* HelperScheduler;
  const composers = yield* ComposerPresence;
  return {
    ...gateway.handlers,
    "helper.status": () => scheduler.status,
    "helper.presence": (presence) =>
      scheduler
        .presence(presence)
        .pipe(Effect.andThen(presence.typing ? composers.typed : Effect.void)),
    "composer.drafts": ({ windowId, threadIds }) => composers.drafts(windowId, threadIds),
  } satisfies Partial<Handlers>;
});
