import { homedir } from "node:os";

import {
  type AgentKind,
  type AgentModel,
  AgentUnavailable,
  customModelsOf,
  GATEWAY_UNLISTED_WARNING,
  gatewayAgentModel,
  GatewayError,
  gatewayKindOf,
  type GatewayModel,
  gatewayModelForAgent,
  gatewayModelUsable,
  type GatewayProfile,
  keyringBackendOk,
  NO_KEYRING_MESSAGE,
  NotFound,
  OPENROUTER_BASE_URL,
  ProfileId,
  type ServerEvent,
  type SetKeyResult,
  type SlashCommand,
  type ThreadId,
  type VaultInfo,
  withCustomModels,
} from "@gram/contracts";
import type { AgentHost } from "@gram/agents";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeDraftPreWake, preWakeOrOff } from "../../host/pre-wake.ts";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { EventHub, isThreadRemoved } from "../../events/event-hub.ts";
import { ComposerPresence } from "../../runtime/composer-presence.ts";
import { modelSuggestions, threadModelSuggestions } from "../../gateway/model-suggestions.ts";
import {
  BASE_URL_SHAPE,
  discoverModels,
  type Fetcher,
  plainBaseURL,
  sameOriginFetch,
} from "../../gateway/discovery.ts";
import {
  makeBridgeVault,
  makeMemoryVault,
  profileKeyRef,
  type KeyVault,
  type VaultPort,
} from "../../gateway/key-vault.ts";
import { codexModelFor } from "../../gateway/codex-home.ts";
import {
  challengeFor,
  exchangeCode,
  listenForCode,
  newVerifier,
  signInUrl,
  type CodeListener,
  type KeyPoster,
} from "../../gateway/openrouter-sign-in.ts";
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
  /** Posts the OpenRouter code exchange; `fetch` by default. */
  readonly post?: KeyPoster;
  /** Listens for OpenRouter's callback; a loopback listener by default. */
  readonly listen?: () => Promise<CodeListener>;
}

const OPENROUTER_PROFILE_ID = ProfileId.make("openrouter");

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
      return {
        kind: "dpapi",
        persisted: true,
        label: "a file encrypted with Windows data protection for your account",
      };
    default:
      return keyringBackendOk(backend)
        ? { kind: "libsecret", persisted: true, label: "the system keyring" }
        : {
            kind: "no-keyring",
            persisted: false,
            label: "nowhere: no system keyring is available",
          };
  }
};

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
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "Antigravity",
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
  post = (url, init) => fetch(url, init),
  listen = () => listenForCode(),
}: GatewayDeps) => {
  const signIns = new Map<string, { readonly verifier: string; readonly listener: CodeListener }>();
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
      Effect.catchTag("VaultError", (error) =>
        Effect.fail(
          new GatewayError({
            profileId: profile.id,
            message:
              error.message === NO_KEYRING_MESSAGE
                ? NO_KEYRING_MESSAGE
                : "Couldn't update the stored key: the key store refused it. Try again, or restart Gram.",
          }),
        ),
      ),
    );

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

  const importOpenCodeKey = (profileId: ProfileId) =>
    Effect.gen(function* () {
      const profile = yield* findProfile(profileId);
      const key = yield* readOpenCodeKey(home, profile.baseURL);
      if (Option.isNone(key)) return { imported: false };
      yield* storeKey(profile, key.value);
      yield* afterKeyChange(profileId, key);
      return { imported: true };
    });

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

  const upsertProfile = ({ profile }: { readonly profile: GatewayProfile }) =>
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
      if (!plainBaseURL(profile.baseURL))
        return yield* Effect.fail(
          new GatewayError({ profileId: profile.id, message: BASE_URL_SHAPE }),
        );
      const profiles = yield* store.listProfiles;
      const existing = profiles.find((p) => p.id === profile.id);
      const noOtherDefault = !profiles.some((p) => p.id !== profile.id && p.default === true);
      const kind = profile.kind ?? gatewayKindOf(profile.baseURL);
      const next: GatewayProfile = {
        ...withoutDefault(profile),
        ...(kind === undefined ? {} : { kind }),
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
    });

  const handlers = {
    "profiles.list": () => store.listProfiles,

    "profiles.upsert": upsertProfile,

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

    "profiles.openRouterSignIn": () =>
      Effect.gen(function* () {
        const listener = yield* Effect.tryPromise({
          try: () => listen(),
          catch: () =>
            new GatewayError({
              profileId: OPENROUTER_PROFILE_ID,
              message: "Couldn't listen for OpenRouter to send you back.",
            }),
        });
        const verifier = newVerifier();
        const attemptId = crypto.randomUUID();
        for (const [id, other] of signIns) {
          other.listener.close();
          signIns.delete(id);
        }
        signIns.set(attemptId, { verifier, listener });
        return { attemptId, url: signInUrl(listener.callbackUrl, challengeFor(verifier)) };
      }),

    "profiles.openRouterFinish": ({ attemptId }) =>
      Effect.gen(function* () {
        const fail = (message: string) =>
          new GatewayError({ profileId: OPENROUTER_PROFILE_ID, message });
        const attempt = signIns.get(attemptId);
        if (attempt === undefined) {
          return yield* fail("This sign-in has ended. Start again.");
        }
        const code = yield* Effect.tryPromise({
          try: () => attempt.listener.code,
          catch: (error) =>
            fail(error instanceof Error ? error.message : "The sign-in didn't finish."),
        }).pipe(Effect.ensuring(Effect.sync(() => signIns.delete(attemptId))));
        const key = yield* exchangeCode(OPENROUTER_PROFILE_ID, code, attempt.verifier, post);
        const profiles = yield* store.listProfiles;
        const existing = profiles.find((profile) => profile.kind === "openrouter");
        const taken = new Set<string>(profiles.map((profile) => profile.id));
        let id: string = OPENROUTER_PROFILE_ID;
        for (let n = 2; taken.has(id); n++) id = `${OPENROUTER_PROFILE_ID}-${n}`;
        const profile =
          existing === undefined
            ? yield* upsertProfile({
                profile: {
                  id: ProfileId.make(id),
                  name: "OpenRouter",
                  baseURL: OPENROUTER_BASE_URL,
                  kind: "openrouter",
                  keyRef: "",
                  models: [],
                },
              })
            : existing;
        yield* storeKey(profile, key);
        const result = yield* afterKeyChange(profile.id, Option.some(key));
        return { ...result, profileId: profile.id };
      }),

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

    "models.list": ({ agent, profileId }) =>
      Effect.gen(function* () {
        const host = yield* hosts.get(agent);
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
          profileModels(
            profile.models.filter((model) => gatewayModelForAgent(profile, model, agent)),
            agent,
            preferred,
            added,
          ),
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

  const parentPort = (process as { parentPort?: VaultPort }).parentPort;
  const vault = parentPort === undefined ? makeMemoryVault() : makeBridgeVault(parentPort);

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
    fetcher: sameOriginFetch,
    home,
    publish: (event) => hub.publish(event),
    onKeyChanged,
    codexModel: codexModelFor(home),
  });

  const credentials = yield* Effect.serviceOption(GatewayCredentials);
  if (Option.isSome(credentials)) yield* credentials.value.install(gateway.credentials);

  const helper = schedulerTitles(yield* HelperScheduler);
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
      hub
        .internalEvents(isThreadRemoved, "thread titles")
        .pipe(Stream.map((event) => ({ threadId: event.threadId, phase: "removed" as const }))),
    ),
    getThread: (threadId) => store.getThread(threadId),
    turnCount: (threadId) => store.listTurns(threadId).pipe(Effect.map((turns) => turns.length)),
    messages: (threadId, limit) => store.firstMessages(threadId, limit),
    commands: (threadId) => Effect.sync(() => sessionCommands.get(threadId)),
    updateThread: (threadId, f) => runtimes.updateThread(threadId, f),
  }).pipe(Effect.forkScoped);

  const scheduler = yield* HelperScheduler;
  const composers = yield* ComposerPresence;
  const drafting = yield* makeDraftPreWake(yield* preWakeOrOff);
  return {
    ...gateway.handlers,
    "helper.status": () => scheduler.status,
    "helper.presence": (presence) =>
      scheduler
        .presence(presence)
        .pipe(
          Effect.andThen(
            presence.typing ? Effect.andThen(composers.typed, drafting.typed) : Effect.void,
          ),
        ),
    "composer.drafts": ({ windowId, threadIds }) =>
      Effect.andThen(composers.drafts(windowId, threadIds), drafting.drafts(windowId, threadIds)),
  } satisfies Partial<Handlers>;
});
