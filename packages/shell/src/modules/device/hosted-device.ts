import { createHmac, type KeyObject, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DeviceCapability, DeviceId, HostedDiscovery, HostedWorkspace } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { AskAnswer, AskRequest, GateFolder } from "./gate.ts";
import { type GrantLedger, makeGrantLedger } from "./grants.ts";
import { checkLendable, type LendBounds } from "./folders.ts";
import {
  discoverHosted,
  type Fetch,
  forgetHostedDevice,
  listHostedWorkspaces,
  makeTokenKeeper,
  registerHostedDevice,
  signInHosted,
  type TokenKeeper,
} from "./hosted.ts";
import {
  deviceIdOf,
  devicePrivateKeyFrom,
  devicePublicKeyText,
  generateDeviceKey,
} from "./keys.ts";
import { type Connect, makeServerLending, type ServerLending } from "./lending.ts";
import { type AskLimits, makeAskLimits } from "./limits.ts";
import { type DeviceLog, type DeviceLogEntry, openDeviceLog } from "./log.ts";
import {
  type DeviceSettings,
  EMPTY_DEVICE_SETTINGS,
  readDeviceSettings,
  writeDeviceSettings,
} from "./settings.ts";

/**
 * This machine as a personal device, whole: the servers the person signed in to, the workspaces
 * they lent it to, and a connection for each while they are at it. It holds every decision's
 * effect, and makes none: signing in to a new server, lending, resuming and lifting a pause are
 * called only from windows the main process owns, once the person has chosen. The local window
 * may read its state, open those windows, and stop lending, which only takes authority away.
 */

/** The operating system's keychain, through the app's key vault. */
export interface DeviceSecrets {
  /**
   * Whether secrets are kept by a real keyring. Without one, a sign-in lasts for the session
   * and lending is unavailable.
   */
  readonly strong: () => boolean;
  readonly get: (name: string) => Promise<string | undefined>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
}

/** Whether the person is at the machine: unlocked, not idle, and the session theirs. */
export interface Presence {
  readonly present: () => boolean;
  /** Whether lock and idle can be told on this system at all; lending needs it. */
  readonly known: () => boolean;
  /** Calls back on any change; answers with a way to stop. */
  readonly onChange: (changed: () => void) => () => void;
}

export interface HostedDeviceOptions {
  /** Where the lending settings and the log are kept: the app's own data folder. */
  readonly dataDir: string;
  readonly secrets: DeviceSecrets;
  readonly fetch: Fetch;
  readonly openBrowser: (url: string) => Promise<void>;
  /**
   * Asks the person, in a window the main process owns, to accept a server they haven't signed
   * in to before. Shown with the origin in its ASCII form and the server's own name as its word.
   */
  readonly confirmServer: (server: {
    readonly origin: string;
    readonly name: string;
  }) => Promise<boolean>;
  readonly ask: (request: AskRequest, withdrawn: AbortSignal) => Promise<AskAnswer>;
  readonly presence: Presence;
  readonly bounds: LendBounds;
  /** The environment commands get, filtered, and the values to redact from their output. */
  readonly environment: () => {
    readonly env: Readonly<Record<string, string>>;
    readonly secrets: ReadonlyArray<string>;
  };
  readonly machineName: string;
  readonly platform: "darwin" | "linux" | "win32";
  /** The wall clock. */
  readonly now: () => number;
  /** A clock that only goes forward. */
  readonly elapsed: () => number;
  readonly connect?: Connect;
  /** Something changed that the windows show. */
  readonly changed?: () => void;
}

export type LendingState = "off" | "on" | "resume";

export interface HostedWorkspaceState {
  readonly id: string;
  /** The server's words. */
  readonly name: string;
  readonly organisation: string;
  /** What the organisation allows a lent machine to do here. */
  readonly policy: HostedWorkspace["devices"];
  readonly lending: LendingState;
  readonly readOnly: boolean;
  readonly folders: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly path: string;
  }>;
  readonly connected: boolean;
}

export interface HostedServerState {
  readonly origin: string;
  /** What the server calls itself: its word. */
  readonly name: string;
  readonly signedIn: boolean;
  readonly paused: boolean;
  readonly workspaces: ReadonlyArray<HostedWorkspaceState>;
  /** The last call that failed, in words. */
  readonly problem?: string;
}

/** Why lending can't be offered here; signing in may still work. */
export type LendingUnavailable = "no-keyring" | "no-lock-signal" | "settings-edited";

export interface HostedDeviceState {
  readonly unavailable?: LendingUnavailable;
  readonly servers: ReadonlyArray<HostedServerState>;
}

export type Done = { readonly ok: true } | { readonly ok: false; readonly why: string };

export interface LendChoice {
  readonly folders: ReadonlyArray<{ readonly path: string; readonly label: string }>;
  readonly readOnly: boolean;
}

export interface HostedDevice {
  readonly state: () => HostedDeviceState;
  /** Finds the server, asks the person to accept a new one, and signs in in the browser. */
  readonly signIn: (typed: string, signal?: AbortSignal) => Promise<Done>;
  readonly signOut: (origin: string) => Promise<void>;
  /** Lists a server's workspaces again. */
  readonly refresh: (origin: string) => Promise<Done>;
  /** A decision: only from the lending sheet. */
  readonly lend: (origin: string, workspace: string, choice: LendChoice) => Promise<Done>;
  /** A decision: only from the lending sheet. */
  readonly resume: (origin: string, workspace: string) => Promise<Done>;
  /** Takes authority away: the local window may call it. */
  readonly stop: (origin: string, workspace: string) => Promise<void>;
  /** A decision: only from the lending sheet. */
  readonly liftPause: (origin: string) => Promise<void>;
  /** The grants for turns the person sends from this machine, for the hosted view. */
  readonly grants: (origin: string) => GrantLedger | undefined;
  /** Ends every connection and closes the log, as a quit does. */
  readonly close: () => Promise<void>;
}

const SETTINGS_FILE = "device-settings.json";
const LOG_FILE = "device-log.jsonl";
/** One secret for this machine's device files; the settings and log keys are derived from it. */
const FILES_SECRET = "device-files";
const keyName = (origin: string) => `device-key ${origin}`;
const signInName = (origin: string) => `device-sign-in ${origin}`;

const derived = (secret: Buffer, use: string) =>
  createHmac("sha256", secret).update(`gram-device-${use}-v1`).digest();

interface StoredSignIn {
  readonly subject: string;
  readonly refreshToken: string;
  readonly deviceId: DeviceId;
}

const parseSignIn = (text: string | undefined): StoredSignIn | undefined => {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<StoredSignIn>;
    return typeof value.subject === "string" &&
      typeof value.refreshToken === "string" &&
      typeof value.deviceId === "string"
      ? (value as StoredSignIn)
      : undefined;
  } catch {
    return undefined;
  }
};

interface Lent {
  state: LendingState;
  readonly folders: Map<string, GateFolder>;
  readOnly: boolean;
}

interface Server {
  readonly origin: string;
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly deviceId: DeviceId;
  readonly keeper: TokenKeeper;
  readonly limits: AskLimits;
  readonly grants: GrantLedger;
  workspaces: ReadonlyArray<HostedWorkspace>;
  readonly lent: Map<string, Lent>;
  readonly connected: Set<string>;
  lending?: ServerLending | undefined;
  scope?: Scope.Closeable | undefined;
  problem?: string | undefined;
}

const capabilitiesOf = (
  policy: HostedWorkspace["devices"] | undefined,
  readOnly: boolean,
): ReadonlyArray<DeviceCapability> =>
  policy === "on" && !readOnly ? ["read", "exec"] : policy === "off" ? [] : ["read"];

const folderId = () => `f-${randomBytes(8).toString("hex")}`;

/** Loads what was saved and keeps it: lending is never on at start, only offered to resume. */
export const makeHostedDevice = async (options: HostedDeviceOptions): Promise<HostedDevice> => {
  const servers = new Map<string, Server>();
  const changed = () => options.changed?.();
  let unavailable: LendingUnavailable | undefined;
  let settings: DeviceSettings = EMPTY_DEVICE_SETTINGS;
  let log: DeviceLog | undefined;
  let fileKeys: { settings: Buffer; log: Buffer } | undefined;
  let closed = false;

  if (!options.secrets.strong()) unavailable = "no-keyring";
  else if (!options.presence.known()) unavailable = "no-lock-signal";

  // The device files' keys come from the keychain; without a real one there are none.
  if (unavailable === undefined) {
    let secret = await options.secrets.get(FILES_SECRET);
    if (secret === undefined) {
      secret = randomBytes(32).toString("base64url");
      await options.secrets.set(FILES_SECRET, secret);
    }
    const bytes = Buffer.from(secret, "base64url");
    fileKeys = { settings: derived(bytes, "settings"), log: derived(bytes, "log") };
    const read = await readDeviceSettings(join(options.dataDir, SETTINGS_FILE), fileKeys.settings);
    if (read.ok) {
      settings = read.settings;
      log = await openDeviceLog(
        join(options.dataDir, LOG_FILE),
        fileKeys.log,
        "logHead" in read ? read.logHead : undefined,
      );
    } else unavailable = "settings-edited";
  }

  const snapshot = (): DeviceSettings => ({
    v: 1,
    servers: [...servers.values()].map((server) => ({
      origin: server.origin,
      paused: server.limits.paused(),
      workspaces: [...server.lent.entries()].map(([id, lent]) => ({
        id,
        readOnly: lent.readOnly,
        folders: [...lent.folders.entries()].map(([fid, folder]) => ({
          id: fid,
          label: folder.label,
          path: folder.path,
          device: folder.device,
          inode: folder.inode,
          fullEnvironment: false,
        })),
      })),
    })),
    ...(log === undefined ? {} : { log: log.head() }),
  });

  /** Settings writes go one at a time, newest last. */
  let writing: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const keys = fileKeys;
    if (keys === undefined || unavailable === "settings-edited") return Promise.resolve();
    writing = writing
      .catch(() => undefined)
      .then(() =>
        writeDeviceSettings(join(options.dataDir, SETTINGS_FILE), keys.settings, snapshot()),
      );
    return writing;
  };

  const logLine = async (entry: DeviceLogEntry): Promise<unknown> => {
    if (log === undefined) return undefined;
    await log.append(entry);
    // Where the log stands is kept with the settings, so lines cut off its end are noticed.
    return save().catch(() => undefined);
  };

  const mayLend = () => unavailable === undefined && !closed;

  const startLending = async (server: Server) => {
    if (server.lending !== undefined || !mayLend()) return;
    const scope = await Effect.runPromise(Scope.make());
    server.scope = scope;
    server.lending = await Effect.runPromise(
      makeServerLending({
        origin: server.origin,
        discovery: server.discovery,
        key: server.key,
        deviceId: server.deviceId,
        platform: options.platform,
        personId: server.keeper.subject,
        keeper: server.keeper,
        grants: server.grants,
        limits: server.limits,
        workspaces: () =>
          [...server.lent.entries()]
            .filter(([, lent]) => lent.state === "on")
            .map(([id, lent]) => ({
              id,
              folders: lent.folders,
              capabilities: capabilitiesOf(
                server.workspaces.find((workspace) => workspace.id === id)?.devices,
                lent.readOnly,
              ),
            })),
        present: () => mayLend() && options.presence.present(),
        ask: options.ask,
        environment: options.environment,
        log: logLine,
        now: options.now,
        elapsed: options.elapsed,
        ...(options.connect === undefined ? {} : { connect: options.connect }),
        onConnection: (workspace, state) => {
          if (state === "connected") server.connected.add(workspace);
          else server.connected.delete(workspace);
          changed();
        },
      }).pipe(Scope.provide(scope)),
    );
  };

  const stopLending = async (server: Server) => {
    const { lending, scope } = server;
    server.lending = undefined;
    server.scope = undefined;
    if (lending !== undefined) await lending.stop("away");
    if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
    server.connected.clear();
  };

  const sync = (server: Server) => {
    server.lending?.sync();
    changed();
  };

  const keeperFor = (
    origin: string,
    discovery: HostedDiscovery,
    key: KeyObject,
    signIn: StoredSignIn,
  ): TokenKeeper =>
    makeTokenKeeper({
      discovery,
      key,
      subject: signIn.subject,
      refreshToken: signIn.refreshToken,
      saveRefreshToken: (refreshToken) =>
        options.secrets.set(signInName(origin), JSON.stringify({ ...signIn, refreshToken })),
      fetch: options.fetch,
      now: options.elapsed,
    });

  const addServer = async (
    origin: string,
    discovery: HostedDiscovery,
    key: KeyObject,
    signIn: StoredSignIn,
    saved?: DeviceSettings["servers"][number],
  ): Promise<Server> => {
    const server: Server = {
      origin,
      discovery,
      key,
      deviceId: signIn.deviceId,
      keeper: keeperFor(origin, discovery, key, signIn),
      limits: makeAskLimits(options.elapsed, { paused: saved?.paused ?? false }, () => {
        // Paused: everything waiting on the person goes, as paused, and the pause is kept.
        void server.lending?.stop("paused");
        void save().catch(() => undefined);
        changed();
      }),
      grants: makeGrantLedger(key, options.now, options.elapsed),
      workspaces: [],
      lent: new Map(),
      connected: new Set(),
    };
    for (const workspace of saved?.workspaces ?? [])
      server.lent.set(workspace.id, {
        state: "resume",
        readOnly: workspace.readOnly,
        folders: new Map(
          workspace.folders.map((folder) => [
            folder.id,
            {
              label: folder.label,
              path: folder.path,
              device: folder.device,
              inode: folder.inode,
              bounds: options.bounds,
            },
          ]),
        ),
      });
    servers.set(origin, server);
    return server;
  };

  const refresh = async (server: Server): Promise<Done> => {
    const listed = await listHostedWorkspaces({
      discovery: server.discovery,
      keeper: server.keeper,
      key: server.key,
      fetch: options.fetch,
    });
    if (!listed.ok) {
      server.problem = listed.why;
      changed();
      return listed;
    }
    server.workspaces = listed.workspaces;
    server.problem = undefined;
    // A workspace no longer listed, or where the organisation turned lending off, is let go.
    for (const id of server.lent.keys()) {
      const listedNow = listed.workspaces.find((workspace) => workspace.id === id);
      if (listedNow === undefined || listedNow.devices === "off") server.lent.delete(id);
    }
    sync(server);
    return { ok: true };
  };

  // What was saved: each server's sign-in from the keychain, its discovery found again.
  for (const saved of settings.servers) {
    const signIn = parseSignIn(await options.secrets.get(signInName(saved.origin)));
    const pem = await options.secrets.get(keyName(saved.origin));
    if (signIn === undefined || pem === undefined) continue;
    const found = await discoverHosted(saved.origin, options.fetch);
    if (!found.ok || found.origin !== saved.origin) continue;
    const server = await addServer(
      saved.origin,
      found.discovery,
      devicePrivateKeyFrom(pem),
      signIn,
      saved,
    );
    await startLending(server);
    void refresh(server);
  }

  const known = (origin: string) => servers.get(origin);

  // Away, locked or back: each server's connections follow.
  const unwatch = options.presence.onChange(() => {
    for (const server of servers.values()) sync(server);
  });

  return {
    state: () => ({
      ...(unavailable === undefined ? {} : { unavailable }),
      servers: [...servers.values()].map((server) => ({
        origin: server.origin,
        name: server.discovery.name,
        signedIn: !server.keeper.signedOut(),
        paused: server.limits.paused(),
        ...(server.problem === undefined ? {} : { problem: server.problem }),
        workspaces: server.workspaces.map((workspace) => {
          const lent = server.lent.get(workspace.id);
          return {
            id: workspace.id,
            name: workspace.name,
            organisation: workspace.organisation,
            policy: workspace.devices,
            lending: lent?.state ?? "off",
            readOnly: lent?.readOnly ?? false,
            folders: [...(lent?.folders ?? new Map<string, GateFolder>()).entries()].map(
              ([id, folder]) => ({ id, label: folder.label, path: folder.path }),
            ),
            connected: server.connected.has(workspace.id),
          };
        }),
      })),
    }),

    signIn: async (typed, signal) => {
      if (closed) return { ok: false, why: "Gram is closing." };
      const found = await discoverHosted(typed, options.fetch);
      if (!found.ok) return found;
      if (servers.has(found.origin)) return { ok: false, why: "You are signed in there already." };
      // A server not signed in to before is a decision.
      if (!settings.servers.some((saved) => saved.origin === found.origin)) {
        const accepted = await options.confirmServer({
          origin: found.origin,
          name: found.discovery.name,
        });
        if (!accepted) return { ok: false, why: "Not signed in." };
      }
      const stored = await options.secrets.get(keyName(found.origin));
      const pem = stored ?? generateDeviceKey().privateKeyPem;
      if (stored === undefined) await options.secrets.set(keyName(found.origin), pem);
      const key = devicePrivateKeyFrom(pem);
      const signed = await signInHosted({
        discovery: found.discovery,
        key,
        openBrowser: options.openBrowser,
        fetch: options.fetch,
        now: options.elapsed,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!signed.ok) return signed;
      if (signed.tokens.refreshToken === undefined)
        return { ok: false, why: "The server gave no lasting sign-in." };
      const first: StoredSignIn = {
        subject: signed.tokens.subject,
        refreshToken: signed.tokens.refreshToken,
        deviceId: deviceIdOf(devicePublicKeyText(key)),
      };
      await options.secrets.set(signInName(found.origin), JSON.stringify(first));
      const server = await addServer(found.origin, found.discovery, key, first);
      const registered = await registerHostedDevice({
        discovery: found.discovery,
        keeper: server.keeper,
        key,
        fetch: options.fetch,
        name: options.machineName,
        platform: options.platform,
      });
      if (!registered.ok) {
        servers.delete(found.origin);
        await server.keeper.signOut();
        await options.secrets.remove(signInName(found.origin));
        return registered;
      }
      await save();
      await startLending(server);
      await refresh(server);
      return { ok: true };
    },

    signOut: async (origin) => {
      const server = known(origin);
      if (server === undefined) return;
      servers.delete(origin);
      server.grants.withdraw({ origin });
      await stopLending(server);
      await forgetHostedDevice({
        discovery: server.discovery,
        keeper: server.keeper,
        key: server.key,
        fetch: options.fetch,
        deviceId: server.deviceId,
      });
      await server.keeper.signOut();
      await options.secrets.remove(signInName(origin));
      await save().catch(() => undefined);
      changed();
    },

    refresh: async (origin) => {
      const server = known(origin);
      return server === undefined ? { ok: false, why: "Not signed in there." } : refresh(server);
    },

    lend: async (origin, workspace, choice) => {
      const server = known(origin);
      if (server === undefined) return { ok: false, why: "Not signed in there." };
      if (!mayLend()) return { ok: false, why: "Lending isn't available on this computer." };
      const listed = server.workspaces.find((each) => each.id === workspace);
      if (listed === undefined || listed.devices === "off")
        return { ok: false, why: "The organisation doesn't allow lending to this workspace." };
      const folders = new Map<string, GateFolder>();
      for (const chosen of choice.folders) {
        const checked = await checkLendable(chosen.path, options.bounds);
        if (!checked.ok) return { ok: false, why: `${chosen.path}: ${checked.why}` };
        folders.set(folderId(), {
          label: chosen.label,
          path: checked.path,
          device: checked.device,
          inode: checked.inode,
          bounds: options.bounds,
        });
      }
      if (folders.size === 0) return { ok: false, why: "Pick at least one folder." };
      server.lent.set(workspace, { state: "on", folders, readOnly: choice.readOnly });
      await save();
      sync(server);
      return { ok: true };
    },

    resume: async (origin, workspace) => {
      const server = known(origin);
      const lent = server?.lent.get(workspace);
      if (server === undefined || lent === undefined)
        return { ok: false, why: "Nothing to resume." };
      if (!mayLend()) return { ok: false, why: "Lending isn't available on this computer." };
      // Each folder must still be the one lent: a folder moved into its place isn't it.
      for (const folder of lent.folders.values()) {
        const checked = await checkLendable(folder.path, options.bounds);
        if (!checked.ok || checked.device !== folder.device || checked.inode !== folder.inode)
          return { ok: false, why: `${folder.path} isn't the folder you lent. Lend it again.` };
      }
      lent.state = "on";
      sync(server);
      return { ok: true };
    },

    stop: async (origin, workspace) => {
      const server = known(origin);
      if (server === undefined || !server.lent.has(workspace)) return;
      server.lent.delete(workspace);
      server.grants.withdraw({ origin, workspace });
      sync(server);
      await save().catch(() => undefined);
    },

    liftPause: async (origin) => {
      const server = known(origin);
      if (server === undefined || !server.limits.paused()) return;
      server.limits.lift();
      await save().catch(() => undefined);
      sync(server);
    },

    grants: (origin) => known(origin)?.grants,

    close: async () => {
      closed = true;
      unwatch();
      await Promise.all([...servers.values()].map(stopLending));
      await writing.catch(() => undefined);
      await log?.close();
    },
  } satisfies HostedDevice;
};
