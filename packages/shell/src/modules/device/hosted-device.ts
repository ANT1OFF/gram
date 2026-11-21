import { createHmac, type KeyObject, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type DeviceId,
  type HostedDiscovery,
  type HostedMachine,
  type HostedRepositoryReach,
  type HostedThreadWaited,
  type HostedWorkspace,
  runsSentWork,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { rename } from "node:fs/promises";
import type { AskAnswer, AskRequest, GateFolder } from "./gate.ts";
import { type GrantLedger, makeGrantLedger } from "./grants.ts";
import { checkLendable, type LendBounds } from "./folders.ts";
import {
  discoverHosted,
  type Fetch,
  exportHostedThread,
  givesThreads,
  importHostedThread,
  settleHostedThread,
  listHostedWorkspaces,
  messageHostedThread,
  startHostedThread,
  checkHostedRepositories,
  hostedMachine,
  stopHostedThread,
  waitHostedThread,
  signInHosted,
  type TokenKeeper,
} from "./hosted.ts";
import { forgetHostedDevice, registerHostedDevice } from "./hosted-registration.ts";
import { capabilitiesOf, folderId, hostOf, markTaker } from "./hosted-device-parts.ts";
import { signInKeeper } from "./sign-in-keeper.ts";
import { machineMarkFor, parseSignIn, type StoredSignIn } from "./stored-sign-in.ts";
import {
  type HostedWorkerMachines,
  hostedWorkerMachines,
  NOT_SIGNED_IN,
} from "./hosted-worker-machines.ts";
import {
  deviceIdOf,
  devicePrivateKeyFrom,
  devicePublicKeyText,
  generateDeviceKey,
} from "./keys.ts";
import { type Connect, makeServerLending, type ServerLending } from "./lending.ts";
import { type AskLimits, makeAskLimits } from "./limits.ts";
import { type DeviceLog, type DeviceLogEntry, openDeviceLog, readDeviceLog } from "./log.ts";
import {
  type DeviceSettings,
  deviceSettingsFit,
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
   * Whether secrets are kept by a real keyring, asked once the app is ready. Without one, a
   * sign-in lasts for the session and lending is unavailable.
   */
  readonly strong: () => Promise<boolean>;
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
  /** It takes threads moved from this machine. */
  readonly takesThreads: boolean;
  /** It gives threads that moved there back to this machine. */
  readonly givesThreads: boolean;
  /** It runs work sent from this machine, and lets it be followed, answered and stopped. */
  readonly runsWork: boolean;
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

export type ThreadMoved =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly notes: readonly string[];
      readonly url?: string;
    }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

export type ThreadFetched =
  | { readonly ok: true; readonly bundle: unknown }
  | { readonly ok: false; readonly why: string };

export type ThreadSettled =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

/** Work to run there, as a new thread of a workspace. `clientKey` makes a second send the same. */
export interface WorkToSend {
  readonly repositories: readonly string[];
  readonly text: string;
  readonly title?: string;
  readonly branch?: string;
  readonly clientKey: string;
}

export type WorkSent =
  | { readonly ok: true; readonly threadId: string; readonly branch?: string }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

/** What to wait for on a thread sent from here. */
export interface WorkWait {
  readonly after?: string;
  readonly until?: "reply" | "idle" | "waiting" | "message";
  readonly timeoutSeconds?: number;
}

export type WorkWaited =
  | { readonly ok: true; readonly waited: HostedThreadWaited }
  | { readonly ok: false; readonly why: string };

export type WorkMessaged =
  | { readonly ok: true; readonly queued: boolean; readonly after?: string }
  | { readonly ok: false; readonly why: string; readonly unknown?: true };

export interface LendChoice {
  readonly folders: ReadonlyArray<{
    readonly path: string;
    readonly label: string;
    /** The folder as it was when shown: a different one at the same path since isn't it. */
    readonly seen?: { readonly device: number; readonly inode: number };
  }>;
  readonly readOnly: boolean;
}

export interface ResumeShown {
  readonly folders: ReadonlyArray<string>;
  readonly readOnly: boolean;
}

/** The local log as the activity list shows it: the newest lines that check out. */
export interface DeviceActivity {
  readonly kept: boolean;
  readonly intact: boolean;
  readonly setAside: boolean;
  /** Newest first. */
  readonly entries: ReadonlyArray<DeviceLogEntry>;
  readonly more: boolean;
}

export interface HostedDevice extends HostedWorkerMachines {
  readonly state: () => HostedDeviceState;
  /** Reads the local log again: at most `most` lines, newest first. */
  readonly activity: (most: number) => Promise<DeviceActivity>;
  /** Finds the server, asks the person to accept a new one, and signs in in the browser. */
  readonly signIn: (typed: string, signal?: AbortSignal) => Promise<Done>;
  readonly signOut: (origin: string) => Promise<void>;
  /** Lists a server's workspaces again. */
  readonly refresh: (origin: string) => Promise<Done>;
  /**
   * Sends a thread this machine exported to one of the server's workspaces, with the person's
   * sign-in, named as coming from this machine. Changes nothing here.
   */
  readonly moveThread: (origin: string, workspace: string, bundle: unknown) => Promise<ThreadMoved>;
  /**
   * Asks for a thread of one of the server's workspaces as a bundle, with the person's sign-in, to
   * bring it back here. Changes nothing here.
   */
  readonly fetchThread: (
    origin: string,
    workspace: string,
    threadId: string,
  ) => Promise<ThreadFetched>;
  /** The thread is here now: its copy there becomes read-only, saying it came to this machine. */
  readonly settleThread: (
    origin: string,
    workspace: string,
    threadId: string,
    exportedAt: number,
  ) => Promise<ThreadSettled>;
  /**
   * Sends work from this machine to run there, as a new thread of one of the person's workspaces,
   * with their sign-in. What runs there runs under that workspace's rules. Changes nothing here.
   */
  readonly sendWork: (origin: string, workspace: string, work: WorkToSend) => Promise<WorkSent>;
  /** Whether a thread there could clone and push each repository. Changes nothing there. */
  readonly checkWork: (
    origin: string,
    workspace: string,
    repositories: readonly string[],
  ) => Promise<
    | { readonly ok: true; readonly reach: HostedRepositoryReach }
    | { readonly ok: false; readonly why: string }
  >;
  /**
   * The person's own machine in a workspace there, read or started unless it runs, for work sent
   * with none running. Only for a send the person makes: never stopped from here.
   */
  readonly machineWork: (
    origin: string,
    workspace: string,
    action: "get" | "start",
  ) => Promise<
    | { readonly ok: true; readonly machine: HostedMachine | "unoffered" }
    | { readonly ok: false; readonly why: string }
  >;
  /** Waits on a thread sent from here: only those, as the server checks again. */
  readonly waitWork: (
    origin: string,
    workspace: string,
    threadId: string,
    wait: WorkWait,
  ) => Promise<WorkWaited>;
  /** A message into a thread sent from here, as the person typed it. */
  readonly messageWork: (
    origin: string,
    workspace: string,
    threadId: string,
    message: {
      readonly text: string;
      readonly mode?: "queue" | "steer" | "interrupt";
      readonly clientKey: string;
    },
  ) => Promise<WorkMessaged>;
  /** Stops the turn a thread sent from here is working on. Takes authority away, so never paused. */
  readonly stopWork: (origin: string, workspace: string, threadId: string) => Promise<Done>;
  /** A decision: only from the lending sheet. */
  readonly lend: (origin: string, workspace: string, choice: LendChoice) => Promise<Done>;
  /**
   * A decision: only from the lending sheet. `shown` is what the person was shown: the folders,
   * which must still be the ones lent, and whether it said reads only, which is then kept.
   */
  readonly resume: (origin: string, workspace: string, shown?: ResumeShown) => Promise<Done>;
  /** Takes authority away: the local window may call it. */
  readonly stop: (origin: string, workspace: string) => Promise<void>;
  /** A decision: only from the lending sheet. */
  readonly liftPause: (origin: string) => Promise<void>;
  /**
   * A decision, only from a window the main process owns: the settings were found edited, and
   * the person chose to set them aside, with the log, and start with nothing lent.
   */
  readonly startAfresh: () => Promise<Done>;
  /** The grants for turns the person sends from this machine, for the hosted view. */
  readonly grants: (origin: string) => GrantLedger | undefined;
  /** Ends every connection and closes the log, as a quit does. */
  readonly close: () => Promise<void>;
}

const SETTINGS_FILE = "device-settings.json";
const LOG_FILE = "device-log.jsonl";
const FILES_SECRET = "device-files";
const keyName = (origin: string) => `device-key ${origin}`;
const signInName = (origin: string) => `device-sign-in ${origin}`;
const SERVERS_MOST = 16;

const derived = (secret: Buffer, use: string) =>
  createHmac("sha256", secret).update(`gram-device-${use}-v1`).digest();

type Store = Pick<DeviceSecrets, "get" | "set" | "remove">;

const memorySecrets = (): Store => {
  const kept = new Map<string, string>();
  return {
    get: async (name) => kept.get(name),
    set: async (name, value) => {
      kept.set(name, value);
    },
    remove: async (name) => {
      kept.delete(name);
    },
  };
};

type KeptFolder = GateFolder & { readonly born: string | undefined };

interface Lent {
  state: LendingState | "saving";
  readonly folders: Map<string, KeptFolder>;
  readOnly: boolean;
}

type SavedServer = DeviceSettings["servers"][number];

interface Server {
  readonly origin: string;
  readonly discovery: HostedDiscovery;
  readonly key: KeyObject;
  readonly deviceId: DeviceId;
  readonly deviceRegistered: boolean;
  readonly keeper: TokenKeeper;
  machineMark: string | undefined;
  formerMarks: ReadonlyArray<string>;
  readonly limits: AskLimits;
  readonly grants: GrantLedger;
  workspaces: ReadonlyArray<HostedWorkspace>;
  readonly lent: Map<string, Lent>;
  readonly connected: Set<string>;
  lending?: ServerLending | undefined;
  starting?: Promise<void> | undefined;
  scope?: Scope.Closeable | undefined;
  problem?: string | undefined;
}

interface Retained {
  readonly saved: SavedServer;
  readonly problem: string;
}

const savedOf = (server: Server): SavedServer => ({
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
      ...(folder.born === undefined ? {} : { born: folder.born }),
      fullEnvironment: false,
    })),
  })),
});

const CLOSING: Done = { ok: false, why: "Gram is closing." };

/** Loads what was saved and keeps it: lending is never on at start, only offered to resume. */
export const makeHostedDevice = async (options: HostedDeviceOptions): Promise<HostedDevice> => {
  const servers = new Map<string, Server>();
  const retained = new Map<string, Retained>();
  const accepted = new Set<string>();
  const signingIn = new Set<string>();
  const closing = new AbortController();
  const changed = () => options.changed?.();
  let unavailable: LendingUnavailable | undefined;
  let settings: DeviceSettings = EMPTY_DEVICE_SETTINGS;
  let log: DeviceLog | undefined;
  let fileKeys: { settings: Buffer; log: Buffer } | undefined;
  let closed = false;
  let secrets: Store = options.secrets;

  let strong = false;
  try {
    strong = await options.secrets.strong();
  } catch {
    strong = false;
  }
  if (!strong) unavailable = "no-keyring";
  else if (!options.presence.known()) unavailable = "no-lock-signal";

  if (unavailable === undefined) {
    try {
      let secret = await secrets.get(FILES_SECRET);
      if (secret === undefined) {
        secret = randomBytes(32).toString("base64url");
        await secrets.set(FILES_SECRET, secret);
      }
      const bytes = Buffer.from(secret, "base64url");
      fileKeys = { settings: derived(bytes, "settings"), log: derived(bytes, "log") };
    } catch {
      unavailable = "no-keyring";
    }
  }
  if (fileKeys !== undefined)
    try {
      const read = await readDeviceSettings(
        join(options.dataDir, SETTINGS_FILE),
        fileKeys.settings,
      );
      if (read.ok) {
        log = await openDeviceLog(
          join(options.dataDir, LOG_FILE),
          fileKeys.log,
          "logHead" in read ? read.logHead : undefined,
        );
        settings = read.settings;
      } else unavailable = "settings-edited";
    } catch {
      unavailable = "settings-edited";
    }
  if (unavailable === "no-keyring" || unavailable === "no-lock-signal") secrets = memorySecrets();
  for (const saved of settings.servers) accepted.add(saved.origin);

  const snapshot = (): DeviceSettings => ({
    v: 1,
    servers: [
      ...[...servers.values()].map(savedOf),
      ...[...retained.values()].map((kept) => kept.saved),
    ],
    ...(log === undefined ? {} : { log: log.head() }),
  });

  let writing: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    const keys = fileKeys;
    if (keys === undefined || unavailable !== undefined || closed) return Promise.resolve();
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
    changed();
    return save().catch(() => undefined);
  };

  const readActivity = async (most: number): Promise<DeviceActivity> => {
    const open = log;
    const keys = fileKeys;
    if (open === undefined || keys === undefined || closed)
      return { kept: false, intact: true, setAside: false, entries: [], more: false };
    const read = await readDeviceLog(join(options.dataDir, LOG_FILE), keys.log, open.head());
    const count = Math.max(0, Math.floor(most));
    return {
      kept: true,
      intact: read.intact,
      setAside: open.foundEdited,
      entries: read.entries.slice(Math.max(0, read.entries.length - count)).toReversed(),
      more: read.entries.length > count,
    };
  };
  let reading:
    | { readonly most: number; readonly lines: number; readonly read: Promise<DeviceActivity> }
    | undefined;

  const mayLend = () => unavailable === undefined && !closed;

  const startLending = (server: Server): Promise<void> => {
    server.starting ??= startLendingNow(server).finally(() => {
      server.starting = undefined;
    });
    return server.starting;
  };

  const startLendingNow = async (server: Server) => {
    if (
      !server.deviceRegistered ||
      server.lending !== undefined ||
      !mayLend() ||
      servers.get(server.origin) !== server
    )
      return;
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
        present: () => mayLend() && !server.keeper.signedOut() && options.presence.present(),
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
    await server.starting?.catch(() => undefined);
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

  const endedByServer = (server: Server) => {
    if (servers.get(server.origin) !== server) return;
    server.grants.withdraw({ origin: server.origin });
    for (const lent of server.lent.values()) lent.state = "resume";
    server.problem = "The server ended the sign-in. Sign in again.";
    void stopLending(server).catch(() => undefined);
    void secrets.remove(signInName(server.origin)).catch(() => undefined);
    changed();
  };

  const keeperFor = (
    origin: string,
    discovery: HostedDiscovery,
    key: KeyObject,
    signIn: StoredSignIn,
    ended: () => void,
    marked?: (mark: string, formerMarks: ReadonlyArray<string>) => void,
  ): TokenKeeper =>
    signInKeeper({
      origin,
      discovery,
      key,
      signIn,
      keep: (stored) => secrets.set(signInName(origin), JSON.stringify(stored)),
      fetch: options.fetch,
      now: options.elapsed,
      ended,
      ...(marked === undefined ? {} : { marked }),
    });

  const makeServer = (
    origin: string,
    discovery: HostedDiscovery,
    key: KeyObject,
    signIn: StoredSignIn,
    saved?: SavedServer,
    keeper?: TokenKeeper,
  ): Server => {
    const marks = markTaker<Server>(changed);
    const server: Server = {
      origin,
      discovery,
      key,
      deviceId: signIn.deviceId,
      deviceRegistered: signIn.deviceRegistered !== false,
      keeper:
        keeper ??
        keeperFor(origin, discovery, key, signIn, () => endedByServer(server), marks.marked),
      machineMark: signIn.machineMark,
      formerMarks: signIn.formerMarks ?? [],
      limits: makeAskLimits(options.elapsed, { paused: saved?.paused ?? false }, () => {
        void server.lending?.stop("paused");
        void save().catch(() => undefined);
        changed();
      }),
      grants: makeGrantLedger(key, options.now, options.elapsed),
      workspaces: [],
      lent: new Map(),
      connected: new Set(),
    };
    marks.take(server);
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
              born: folder.born,
              bounds: options.bounds,
            },
          ]),
        ),
      });
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
    server.workspaces = server.deviceRegistered
      ? listed.workspaces
      : listed.workspaces.map((workspace) => ({ ...workspace, devices: "off" }));
    server.problem = undefined;
    let dropped = false;
    for (const id of server.lent.keys()) {
      const listedNow = server.workspaces.find((workspace) => workspace.id === id);
      if (listedNow !== undefined && listedNow.devices !== "off") continue;
      server.lent.delete(id);
      server.grants.withdraw({ origin: server.origin, workspace: id });
      dropped = true;
    }
    sync(server);
    if (dropped) await save().catch(() => undefined);
    return { ok: true };
  };

  const restore = async (saved: SavedServer): Promise<Done> => {
    if (signingIn.has(saved.origin)) return { ok: false, why: "Signing in there already." };
    signingIn.add(saved.origin);
    const still = () => retained.get(saved.origin)?.saved === saved;
    const keep = (why: string): Done => {
      if (still()) retained.set(saved.origin, { saved, problem: why });
      return { ok: false, why };
    };
    try {
      const signIn = parseSignIn(await secrets.get(signInName(saved.origin)));
      const pem = await secrets.get(keyName(saved.origin));
      if (signIn === undefined || pem === undefined) {
        return keep("Signed out. Sign in again.");
      }
      const found = await discoverHosted(saved.origin, options.fetch);
      if (!found.ok || found.origin !== saved.origin) {
        return keep("Gram couldn't reach this server.");
      }
      if (closed) return CLOSING;
      if (!still()) return { ok: false, why: "Not signed in there." };
      const server = makeServer(
        saved.origin,
        found.discovery,
        devicePrivateKeyFrom(pem),
        signIn,
        saved,
      );
      retained.delete(saved.origin);
      servers.set(saved.origin, server);
      await startLending(server);
      void refresh(server).catch(() => undefined);
      return { ok: true };
    } catch {
      return keep("Gram couldn't read this server's sign-in.");
    } finally {
      signingIn.delete(saved.origin);
    }
  };

  for (const saved of settings.servers)
    retained.set(saved.origin, { saved, problem: "Connecting to the server." });
  for (const saved of settings.servers) await restore(saved);

  const known = (origin: string) => servers.get(origin);

  const refusedForThreads = (server: Server | undefined, workspace: string) => {
    if (server === undefined || server.keeper.signedOut()) return NOT_SIGNED_IN;
    if (server.limits.paused())
      return {
        ok: false as const,
        why: "You paused this computer for that server. Lift the pause under Settings → Hosted first.",
      };
    if (!server.workspaces.some((each) => each.id === workspace))
      return { ok: false as const, why: "That workspace isn't one of yours there." };
    return undefined;
  };

  const callsOf = (server: Server) => ({
    discovery: server.discovery,
    keeper: server.keeper,
    key: server.key,
    fetch: options.fetch,
  });

  const machineFrom = () => [...options.machineName].slice(0, 200).join("") || "this computer";

  const unwatch = options.presence.onChange(() => {
    for (const server of servers.values()) sync(server);
  });

  const signIn = async (typed: string, signal?: AbortSignal): Promise<Done> => {
    if (closed) return CLOSING;
    const found = await discoverHosted(typed, options.fetch);
    if (closed) return CLOSING;
    if (!found.ok) return found;
    const { origin } = found;
    const there = servers.get(origin);
    if (there !== undefined && !there.keeper.signedOut())
      return { ok: false, why: "You are signed in there already." };
    if (signingIn.has(origin)) return { ok: false, why: "Signing in there already." };
    const replacing = there !== undefined || retained.has(origin);
    const starting = [...signingIn].filter((each) => !servers.has(each) && !retained.has(each));
    if (!replacing && servers.size + retained.size + starting.length >= SERVERS_MOST)
      return {
        ok: false,
        why: `Gram keeps at most ${SERVERS_MOST} servers. Sign out of one first.`,
      };
    signingIn.add(origin);
    const undo: Array<() => Promise<unknown>> = [];
    const giveUp = async (done: Done): Promise<Done> => {
      for (const step of undo.toReversed()) await step().catch(() => undefined);
      return done;
    };
    try {
      if (!accepted.has(origin)) {
        const yes = await options.confirmServer({ origin, name: found.discovery.name });
        if (closed) return CLOSING;
        if (!yes) return { ok: false, why: "Not signed in." };
      }
      const stored = await secrets.get(keyName(origin));
      const pem = stored ?? generateDeviceKey().privateKeyPem;
      if (stored === undefined) {
        await secrets.set(keyName(origin), pem);
        undo.push(() => secrets.remove(keyName(origin)));
      }
      if (closed) return await giveUp(CLOSING);
      const key = devicePrivateKeyFrom(pem);
      const signed = await signInHosted({
        discovery: found.discovery,
        key,
        openBrowser: options.openBrowser,
        fetch: options.fetch,
        now: options.elapsed,
        signal: signal === undefined ? closing.signal : AbortSignal.any([signal, closing.signal]),
        deviceName: options.machineName,
      });
      if (closed) return await giveUp(CLOSING);
      if (!signed.ok) return await giveUp(signed);
      if (signed.tokens.refreshToken === undefined)
        return await giveUp({ ok: false, why: "The server gave no lasting sign-in." });
      const scopes = signed.tokens.grantedScopes;
      const registerDevice =
        scopes === undefined ||
        (scopes.includes("device:register") && scopes.includes("device:connect"));
      const first: StoredSignIn = {
        subject: signed.tokens.subject,
        refreshToken: signed.tokens.refreshToken,
        deviceId: deviceIdOf(devicePublicKeyText(key)),
        ...(registerDevice ? {} : { deviceRegistered: false }),
        machineMark: machineMarkFor(origin, signed.tokens.subject, signed.tokens.organization),
        ...(signed.tokens.organization === undefined ? {} : { machineMarkOrg: true as const }),
      };
      const previous = await secrets.get(signInName(origin));
      await secrets.set(signInName(origin), JSON.stringify(first));
      undo.push(() =>
        previous === undefined
          ? secrets.remove(signInName(origin))
          : secrets.set(signInName(origin), previous),
      );
      const marks = markTaker<Server>(changed);
      const ended = () => marks.with(endedByServer);
      const keeper = keeperFor(origin, found.discovery, key, first, ended, marks.marked);
      undo.push(() => keeper.signOut());
      if (closed) return await giveUp(CLOSING);
      if (registerDevice) {
        const registered = await registerHostedDevice({
          discovery: found.discovery,
          keeper,
          key,
          fetch: options.fetch,
          name: options.machineName,
          platform: options.platform,
        });
        if (!registered.ok) return await giveUp(registered);
        if (stored === undefined)
          undo.push(() =>
            forgetHostedDevice({
              discovery: found.discovery,
              keeper,
              key,
              fetch: options.fetch,
              deviceId: first.deviceId,
            }),
          );
      }
      if (closed) return await giveUp(CLOSING);
      if (keeper.signedOut()) return await giveUp({ ok: false, why: "The sign-in ended." });
      const current = servers.get(origin);
      const kept = retained.get(origin);
      const before = current === undefined ? kept?.saved : savedOf(current);
      const server = makeServer(origin, found.discovery, key, first, before, keeper);
      servers.delete(origin);
      retained.delete(origin);
      servers.set(origin, server);
      if (!deviceSettingsFit(snapshot())) {
        servers.delete(origin);
        if (current !== undefined) servers.set(origin, current);
        if (kept !== undefined) retained.set(origin, kept);
        return await giveUp({
          ok: false,
          why: `Gram keeps at most ${SERVERS_MOST} servers. Sign out of one first.`,
        });
      }
      marks.take(server);
      if (current !== undefined) await stopLending(current);
      accepted.add(origin);
      await save().catch(() => undefined);
      await startLending(server);
      await refresh(server);
      return { ok: true };
    } finally {
      signingIn.delete(origin);
    }
  };

  return {
    state: () => ({
      ...(unavailable === undefined ? {} : { unavailable }),
      servers: [
        ...[...servers.values()].map((server) => ({
          origin: server.origin,
          name: server.discovery.name,
          signedIn: !server.keeper.signedOut(),
          paused: server.limits.paused(),
          takesThreads: server.discovery.thread_import_endpoint !== undefined,
          givesThreads: givesThreads(server.discovery),
          runsWork: runsSentWork(server.discovery),
          ...(server.problem === undefined ? {} : { problem: server.problem }),
          workspaces: server.workspaces.map((workspace) => {
            const lent = server.lent.get(workspace.id);
            return {
              id: workspace.id,
              name: workspace.name,
              organisation: workspace.organisation,
              policy: workspace.devices,
              lending: lent === undefined || lent.state === "saving" ? "off" : lent.state,
              readOnly: lent?.readOnly ?? false,
              folders: [...(lent?.folders ?? new Map<string, KeptFolder>()).entries()].map(
                ([id, folder]) => ({ id, label: folder.label, path: folder.path }),
              ),
              connected: server.connected.has(workspace.id),
            };
          }),
        })),
        ...[...retained.values()].map((kept) => ({
          origin: kept.saved.origin,
          name: hostOf(kept.saved.origin),
          signedIn: false,
          paused: kept.saved.paused,
          takesThreads: false,
          givesThreads: false,
          runsWork: false,
          problem: kept.problem,
          workspaces: [],
        })),
      ],
    }),

    signIn,

    signOut: async (origin) => {
      const server = known(origin);
      if (server === undefined) {
        if (!retained.delete(origin)) return;
      } else {
        servers.delete(origin);
        server.grants.withdraw({ origin });
        await stopLending(server);
        if (server.deviceRegistered && !server.keeper.signedOut())
          await forgetHostedDevice({
            discovery: server.discovery,
            keeper: server.keeper,
            key: server.key,
            fetch: options.fetch,
            deviceId: server.deviceId,
          });
        await server.keeper.signOut();
      }
      accepted.delete(origin);
      await secrets.remove(signInName(origin)).catch(() => undefined);
      await secrets.remove(keyName(origin)).catch(() => undefined);
      await save().catch(() => undefined);
      changed();
    },

    moveThread: async (origin, workspace, bundle) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return importHostedThread({
        discovery: server.discovery,
        keeper: server.keeper,
        key: server.key,
        fetch: options.fetch,
        workspaceId: workspace,
        bundle,
        from: machineFrom(),
      });
    },

    fetchThread: async (origin, workspace, threadId) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return exportHostedThread({
        discovery: server.discovery,
        keeper: server.keeper,
        key: server.key,
        fetch: options.fetch,
        workspaceId: workspace,
        threadId,
      });
    },

    settleThread: async (origin, workspace, threadId, exportedAt) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return settleHostedThread({
        discovery: server.discovery,
        keeper: server.keeper,
        key: server.key,
        fetch: options.fetch,
        workspaceId: workspace,
        threadId,
        exportedAt,
        to: machineFrom(),
      });
    },

    sendWork: async (origin, workspace, work) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return startHostedThread({
        ...callsOf(server),
        workspaceId: workspace,
        repositories: work.repositories,
        text: work.text,
        ...(work.title === undefined ? {} : { title: work.title }),
        ...(work.branch === undefined ? {} : { branch: work.branch }),
        clientKey: work.clientKey,
      });
    },

    checkWork: async (origin, workspace, repositories) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return checkHostedRepositories({ ...callsOf(server), workspaceId: workspace, repositories });
    },

    machineWork: async (origin, workspace, action) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return hostedMachine({ ...callsOf(server), workspaceId: workspace, action });
    },

    waitWork: async (origin, workspace, threadId, wait) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return waitHostedThread({
        ...callsOf(server),
        workspaceId: workspace,
        threadId,
        ...(wait.after === undefined ? {} : { after: wait.after }),
        ...(wait.until === undefined ? {} : { until: wait.until }),
        ...(wait.timeoutSeconds === undefined ? {} : { timeoutSeconds: wait.timeoutSeconds }),
      });
    },

    messageWork: async (origin, workspace, threadId, message) => {
      const server = known(origin);
      const refused = refusedForThreads(server, workspace);
      if (refused !== undefined || server === undefined) return refused ?? NOT_SIGNED_IN;
      return messageHostedThread({
        ...callsOf(server),
        workspaceId: workspace,
        threadId,
        text: message.text,
        ...(message.mode === undefined ? {} : { mode: message.mode }),
        clientKey: message.clientKey,
      });
    },

    ...hostedWorkerMachines({
      servers: () => servers.values(),
      known,
      callsOf,
    }),

    stopWork: async (origin, workspace, threadId) => {
      const server = known(origin);
      if (server === undefined || server.keeper.signedOut()) return NOT_SIGNED_IN;
      return stopHostedThread({ ...callsOf(server), workspaceId: workspace, threadId });
    },

    refresh: async (origin) => {
      const server = known(origin);
      if (server !== undefined) return refresh(server);
      const kept = retained.get(origin);
      if (kept === undefined) return { ok: false, why: "Not signed in there." };
      const done = await restore(kept.saved);
      changed();
      return done;
    },

    lend: async (origin, workspace, choice) => {
      const server = known(origin);
      if (server === undefined || server.keeper.signedOut())
        return { ok: false, why: "Not signed in there." };
      if (!mayLend()) return { ok: false, why: "Lending isn't available on this computer." };
      const listed = server.workspaces.find((each) => each.id === workspace);
      if (listed === undefined || listed.devices === "off")
        return { ok: false, why: "The organisation doesn't allow lending to this workspace." };
      const folders = new Map<string, KeptFolder>();
      for (const chosen of choice.folders) {
        const checked = await checkLendable(chosen.path, options.bounds);
        if (!checked.ok) return { ok: false, why: `${chosen.path}: ${checked.why}` };
        if (
          checked.path !== chosen.path ||
          (chosen.seen !== undefined &&
            (chosen.seen.device !== checked.device || chosen.seen.inode !== checked.inode))
        )
          return { ok: false, why: `${chosen.path} changed since you chose it. Choose it again.` };
        folders.set(folderId(), {
          label: chosen.label,
          path: checked.path,
          device: checked.device,
          inode: checked.inode,
          born: checked.born,
          bounds: options.bounds,
        });
      }
      if (folders.size === 0) return { ok: false, why: "Pick at least one folder." };
      if (!mayLend() || known(origin) !== server)
        return { ok: false, why: "Lending isn't available on this computer." };
      const before = server.lent.get(workspace);
      const putBack = () => {
        if (before === undefined) server.lent.delete(workspace);
        else server.lent.set(workspace, before);
      };
      const lent: Lent = { state: "saving", folders, readOnly: choice.readOnly };
      server.lent.set(workspace, lent);
      if (!deviceSettingsFit(snapshot())) {
        putBack();
        return {
          ok: false,
          why: "That's more than Gram keeps: at most 32 folders, each label at most 128 characters.",
        };
      }
      try {
        await save();
      } catch {
        if (server.lent.get(workspace) === lent) putBack();
        sync(server);
        return { ok: false, why: "Gram couldn't save what you lent, so nothing is lent." };
      }
      if (server.keeper.signedOut()) {
        if (server.lent.get(workspace) === lent) lent.state = "resume";
        changed();
        return { ok: false, why: "The sign-in ended. Sign in again." };
      }
      if (server.lent.get(workspace) !== lent || known(origin) !== server)
        return { ok: false, why: "Lending was stopped." };
      lent.state = "on";
      sync(server);
      return { ok: true };
    },

    resume: async (origin, workspace, shown) => {
      const server = known(origin);
      const lent = server?.lent.get(workspace);
      if (server === undefined || lent === undefined || lent.state !== "resume")
        return { ok: false, why: "Nothing to resume." };
      const same = (ids: ReadonlyArray<string>) =>
        ids.length === lent.folders.size && ids.every((id) => lent.folders.has(id));
      if (shown !== undefined && !same(shown.folders))
        return { ok: false, why: "What was lent changed. Try again." };
      if (server.keeper.signedOut()) return { ok: false, why: "Sign in there again first." };
      if (!mayLend()) return { ok: false, why: "Lending isn't available on this computer." };
      const listed = server.workspaces.find((each) => each.id === workspace);
      if (listed === undefined)
        return { ok: false, why: "Gram hasn't got this workspace from the server yet. Try again." };
      if (listed.devices === "off")
        return { ok: false, why: "The organisation doesn't allow lending to this workspace." };
      for (const folder of lent.folders.values()) {
        const checked = await checkLendable(folder.path, options.bounds);
        if (
          !checked.ok ||
          checked.device !== folder.device ||
          checked.inode !== folder.inode ||
          folder.born === undefined ||
          checked.born !== folder.born
        )
          return { ok: false, why: `${folder.path} isn't the folder you lent. Lend it again.` };
      }
      if (server.lent.get(workspace) !== lent || !mayLend())
        return { ok: false, why: "Nothing to resume." };
      if (shown !== undefined && !same(shown.folders))
        return { ok: false, why: "What was lent changed. Try again." };
      if (shown?.readOnly === true) lent.readOnly = true;
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
      if (closed || server === undefined || !server.limits.paused()) return;
      server.limits.lift();
      await save().catch(() => undefined);
      sync(server);
    },

    startAfresh: async () => {
      const keys = fileKeys;
      if (unavailable !== "settings-edited" || keys === undefined || closed)
        return { ok: false, why: "There is nothing to set aside." };
      const aside = `edited-${options.now()}-${randomBytes(4).toString("hex")}`;
      try {
        const old = log;
        log = undefined;
        await old?.close();
        for (const file of [SETTINGS_FILE, LOG_FILE]) {
          const path = join(options.dataDir, file);
          await rename(path, `${path}.${aside}`).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        log = await openDeviceLog(join(options.dataDir, LOG_FILE), keys.log);
      } catch {
        return { ok: false, why: "Gram couldn't set the old settings aside." };
      }
      settings = EMPTY_DEVICE_SETTINGS;
      unavailable = undefined;
      try {
        await save();
      } catch {
        unavailable = "settings-edited";
        return { ok: false, why: "Gram couldn't write new settings." };
      }
      for (const server of servers.values()) await startLending(server);
      changed();
      return { ok: true };
    },

    grants: (origin) => known(origin)?.grants,

    activity: (most) => {
      const lines = log?.head().count ?? -1;
      if (reading?.most !== most || reading.lines !== lines) {
        const read = readActivity(most).finally(() => {
          if (reading?.read === read) reading = undefined;
        });
        reading = { most, lines, read };
      }
      return reading.read;
    },

    close: async () => {
      closed = true;
      closing.abort();
      unwatch();
      await Promise.all([...servers.values()].map(stopLending));
      await writing.catch(() => undefined);
      await log?.close();
    },
  } satisfies HostedDevice;
};
