import { execFile } from "node:child_process";
import type { RemoteAccessStatus, TailscaleState } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "../platform/unstable.ts";
import { ServerConfig } from "../config.ts";
import type { DialAccess } from "../host/paired-machines.ts";
import { createRemoteAccess, remoteOrigin, type RemoteAccess } from "./remote-access.ts";
import { fileRemoteSessionStore, privateJsonFile } from "./remote-sessions.ts";

export class TailscaleMissing extends Data.TaggedError("TailscaleMissing")<{}> {}

export interface TailscaleRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TailscaleShape {
  /** Runs the `tailscale` CLI with `args`, never through a shell. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<TailscaleRun, TailscaleMissing>;
}

/**
 * The Tailscale CLI. The default finds none, so tests never touch a real tailnet; `main.ts`
 * provides {@link TailscaleLive}.
 */
export const Tailscale = Context.Reference<TailscaleShape>("@gram/server/Tailscale", {
  defaultValue: () => ({ run: () => Effect.fail(new TailscaleMissing()) }),
});

/** Where the CLI is: on PATH, Homebrew's, or inside the Mac app, which a packaged Gram's PATH lacks. */
const CLI_CANDIDATES =
  process.platform === "darwin"
    ? [
        "tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ]
    : ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];

const runFile = (file: string, args: ReadonlyArray<string>) =>
  Effect.callback<TailscaleRun | undefined>((resume) => {
    const child = execFile(
      file,
      [...args],
      { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
          return resume(Effect.succeed(undefined));
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resume(Effect.succeed({ code, stdout: String(stdout), stderr: String(stderr) }));
      },
    );
    return Effect.sync(() => child.kill());
  });

export const TailscaleLive: Layer.Layer<never> = Layer.succeed(Tailscale, {
  run: (args) =>
    Effect.gen(function* () {
      for (const file of CLI_CANDIDATES) {
        const result = yield* runFile(file, args);
        if (result !== undefined) return result;
      }
      return yield* new TailscaleMissing();
    }),
});

/** Reads `tailscale status --json`: running, signed in, and with HTTPS certificates allowed. */
export const tailscaleState = (tailscale: TailscaleShape): Effect.Effect<TailscaleState> =>
  tailscale.run(["status", "--json"]).pipe(
    Effect.map((result): TailscaleState => {
      const status = parseJson(result.stdout);
      const backend = status?.["BackendState"];
      if (backend === "NeedsLogin" || backend === "NeedsMachineAuth")
        return { state: "signed-out" };
      if (backend !== "Running")
        return result.code === 0 ? { state: "stopped" } : { state: "error" };
      const self = status?.["Self"];
      const raw =
        typeof self === "object" && self !== null && "DNSName" in self ? self.DNSName : undefined;
      const dnsName = typeof raw === "string" ? raw.replace(/\.$/, "").toLowerCase() : "";
      if (!tailnetName(dnsName)) return { state: "error" };
      const certs = status?.["CertDomains"];
      return Array.isArray(certs) && certs.includes(dnsName)
        ? { state: "ready", dnsName }
        : { state: "no-https", dnsName };
    }),
    Effect.catchTag("TailscaleMissing", () => Effect.succeed({ state: "missing" } as const)),
  );

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const tailnetName = (name: string) => {
  try {
    remoteOrigin(`https://${name}`);
    return true;
  } catch {
    return false;
  }
};

const portOf = (origin: string) => Number(new URL(origin).port || 443);

export const originFor = (dnsName: string, port: number): string =>
  port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;

/** One HTTPS Serve listener as `tailscale serve status --json` reports it. */
export interface ServeListener {
  readonly port: number;
  /** The `/` handler's proxy target, when it is a proxy. */
  readonly proxy: string | undefined;
  /** How many path handlers the listener has; Gram's has only `/`. */
  readonly handlers: number;
  readonly funnel: boolean;
}

export const serveListeners = (
  tailscale: TailscaleShape,
  dnsName: string,
): Effect.Effect<ReadonlyArray<ServeListener> | undefined> =>
  tailscale.run(["serve", "status", "--json"]).pipe(
    Effect.map((result) => {
      if (result.code !== 0) return undefined;
      const status = parseJson(result.stdout.trim() === "" ? "{}" : result.stdout);
      if (status === undefined) return undefined;
      const tcp = record(status["TCP"]);
      const web = record(status["Web"]);
      const funnel = record(status["AllowFunnel"]);
      return Object.keys(tcp).map((key): ServeListener => {
        const port = Number(key);
        const handlers = record(record(web[`${dnsName}:${port}`])["Handlers"]);
        const proxy = record(handlers["/"])["Proxy"];
        return {
          port,
          proxy: typeof proxy === "string" ? proxy.replace(/\/$/, "") : undefined,
          handlers: Object.keys(handlers).length,
          funnel: funnel[`${dnsName}:${port}`] === true,
        };
      });
    }),
    Effect.catchTag("TailscaleMissing", () => Effect.succeed(undefined)),
  );

/** The ports Gram tries, in order, when it picks one itself. */
export const SERVE_PORTS = [9443, 9444, 9445, 9446, 8443] as const;
const GRAM_TARGET = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export class RemoteRefused extends Data.TaggedError("RemoteRefused")<{
  readonly message: string;
  /** Tailscale didn't answer, which one more look may well fix. */
  readonly transient?: boolean;
}> {}

interface ServeSetting {
  readonly enabled: boolean;
  readonly port: number;
  /**
   * The exact target Gram last pointed its listener at. Only a listener on `port` with this one
   * `/` proxy and no other handler is Gram's; any other is the user's and is never touched.
   */
  readonly target?: string;
}

/** `<dataDir>/remote-access/serve.json`: whether Settings turned phone access on, and its port. */
const serveSettingFile = (dataDir: string) => {
  const file = privateJsonFile(dataDir, "serve.json", 1024);
  return {
    read: (): ServeSetting | undefined => {
      const value = file.read();
      if (value === undefined) return undefined;
      const saved = record(value);
      if (
        saved["version"] !== 1 ||
        typeof saved["enabled"] !== "boolean" ||
        !Number.isInteger(saved["port"]) ||
        Number(saved["port"]) < 1 ||
        Number(saved["port"]) > 65535 ||
        (saved["target"] !== undefined &&
          !(typeof saved["target"] === "string" && GRAM_TARGET.test(saved["target"])))
      )
        throw new Error("Remote access storage is invalid");
      return {
        enabled: saved["enabled"],
        port: Number(saved["port"]),
        ...(typeof saved["target"] === "string" ? { target: saved["target"] } : {}),
      };
    },
    write: (setting: ServeSetting) => file.write({ version: 1, ...setting }),
  };
};

export interface RemoteControlShape {
  /** The remote access serving right now, if any; read on every request. */
  readonly current: () => RemoteAccess | undefined;
  /**
   * Whether joined machines can dial in: on, switched off, or switched on but down and why, from
   * the last look at Tailscale. Read on every machines listing, so it never runs the CLI.
   */
  readonly dialAccess: () => DialAccess;
  /**
   * Calls `listener` with the origin access is served on each time it opens, closes or moves,
   * and at once when it is open, so joined machines' connections follow it. Returns the unwatch.
   */
  readonly watch: (listener: (origin: string | undefined) => void) => () => void;
  readonly status: Effect.Effect<RemoteAccessStatus>;
  /** Turns phone access on through Tailscale Serve, on `port` or one Gram picks. */
  readonly enable: (port?: number) => Effect.Effect<RemoteAccessStatus, RemoteRefused>;
  /** Removes Gram's Serve listener and closes remote connections; pairings are kept. */
  readonly disable: Effect.Effect<RemoteAccessStatus, RemoteRefused>;
}

const refused = (message: string) => Effect.fail(new RemoteRefused({ message }));

/**
 * After a failed try at serving while the switch is on, how long Gram waits before the next:
 * doubling to a minute, then a minute apart.
 */
export const RECOVERY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
/** While serving, or while the switch is off, how often Gram looks again. */
export const RECHECK_MS = 60_000;

const OFF_UNSAVED =
  "Turned off, but the setting couldn't be saved, so it turns back on when Gram restarts";

const here = process.platform === "darwin" ? "this Mac" : "this computer";

/** Why the switch is on but Gram isn't serving, when Tailscale itself is the cause. */
export const downMessage = (state: TailscaleState): string | undefined => {
  switch (state.state) {
    case "missing":
      return `Gram can't find Tailscale on ${here}. Once it's installed, Gram sets up access by itself.`;
    case "signed-out":
      return `Tailscale is signed out on ${here}. Sign in, and Gram sets up access again by itself.`;
    case "stopped":
      return `Tailscale is stopped on ${here}. Turn it on, and Gram sets up access again by itself.`;
    case "no-https":
      return "Turn on HTTPS certificates for your tailnet in the Tailscale admin console. Gram sets up access again by itself.";
    case "error":
      return "Tailscale didn't answer. Gram tries again by itself.";
    case "ready":
      return undefined;
  }
};

const stateMessage = (state: TailscaleState): string => {
  switch (state.state) {
    case "missing":
      return "Tailscale isn't installed on this computer";
    case "signed-out":
      return "Sign in to Tailscale on this computer first";
    case "stopped":
      return "Tailscale isn't connected on this computer";
    case "no-https":
      return "Turn on HTTPS certificates for your tailnet in the Tailscale admin console";
    case "error":
      return "Tailscale didn't answer";
    case "ready":
      return "";
  }
};

/**
 * Phone access, switched from Settings. `GRAM_REMOTE_ORIGIN` wins when set: the origin is fixed,
 * Serve is the user's to configure, and the switch is locked. Otherwise Gram adds and removes its
 * own HTTPS Serve listener, never Funnel and never another listener, and points it at this run's
 * loopback port.
 */
export class RemoteControl extends Context.Service<RemoteControl, RemoteControlShape>()(
  "@gram/server/RemoteControl",
) {
  static readonly layer: Layer.Layer<RemoteControl, never, ServerConfig | HttpServer.HttpServer> =
    Layer.effect(RemoteControl)(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const server = yield* HttpServer.HttpServer;
        const cli = yield* Tailscale;
        // One CLI call at a time: a status check never races recovery, enable or disable.
        const cliLock = yield* Semaphore.make(1);
        const tailscale: TailscaleShape = { run: (args) => cliLock.withPermits(1)(cli.run(args)) };
        const loopback = "port" in server.address ? server.address.port : 0;
        if (config.remoteOrigin !== undefined) {
          const origin = config.remoteOrigin;
          const access = createRemoteAccess(
            origin,
            loopback,
            Date.now,
            fileRemoteSessionStore(config.dataDir, origin, loopback),
          );
          const status = Effect.sync((): RemoteAccessStatus => ({
            mode: "env",
            tailscale: { state: "ready", dnsName: new URL(origin).hostname },
            port: Number(new URL(origin).port || 443),
            origin,
            devices: access.devices(),
            ...pairingOf(access),
          }));
          const locked = refused("GRAM_REMOTE_ORIGIN sets phone access; unset it to switch here");
          return RemoteControl.of({
            current: () => access,
            dialAccess: () => "on",
            watch: (listener) => {
              listener(origin);
              return () => {};
            },
            status,
            enable: () => locked,
            disable: locked,
          });
        }

        // Opened on use, so a server that never turns phone access on creates no folder.
        const settings = {
          read: () => serveSettingFile(config.dataDir).read(),
          write: (setting: ServeSetting) => serveSettingFile(config.dataDir).write(setting),
        };
        const lock = yield* Semaphore.make(1);
        let access: RemoteAccess | undefined;
        const watchers = new Set<(origin: string | undefined) => void>();
        /**
         * Opens, replaces or closes access. A replaced or closed one disconnects its browsers, and
         * watchers hear of every change, so no connection or dial outlives the access it came in on.
         */
        const setAccess = (next: RemoteAccess | undefined) => {
          const previous = access;
          if (previous === next) return;
          access = next;
          previous?.close();
          if (previous?.origin === next?.origin) return;
          for (const watcher of watchers) watcher(next?.origin);
        };
        /**
         * Set by turning off, cleared by turning on: the user's choice, kept even when saving it
         * failed, so recovery never serves again what the user turned off.
         */
        let wantOff = false;
        /** Looks in a row that Tailscale didn't answer; one is borne before access closes. */
        let unanswered = 0;
        /** Why the last try at serving, or at turning off, failed, other than Tailscale being down. */
        let problem: string | undefined;
        /**
         * Set while a turn-off couldn't remove Gram's listener: recovery keeps trying to remove it,
         * rather than serving again, until it is gone.
         */
        let turningOff: { readonly port: number; readonly owned: string | undefined } | undefined;
        /** Tailscale's state when recovery last looked, so a status that finds it back wakes it. */
        let recoverySaw: TailscaleState["state"] | undefined;
        let wakeRecovery = Deferred.makeUnsafe<void>();
        const wake = () => Deferred.doneUnsafe(wakeRecovery, Exit.void);
        let tailscaleSeen: { at: number; state: TailscaleState } | undefined;
        // One look at a time, so a caller that waited reuses the look just taken.
        const probeLock = yield* Semaphore.make(1);
        const probe = (fresh = false) =>
          probeLock.withPermits(1)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              if (!fresh && tailscaleSeen !== undefined && now - tailscaleSeen.at < 15_000)
                return tailscaleSeen.state;
              const state = yield* tailscaleState(tailscale);
              tailscaleSeen = { at: yield* Clock.currentTimeMillis, state };
              return state;
            }),
          );
        const readSetting = () => {
          try {
            return settings.read();
          } catch {
            return undefined;
          }
        };
        const target = `http://127.0.0.1:${loopback}`;
        /** The listener this run added and hasn't removed yet, for the shutdown finalizer. */
        let applied: number | undefined;
        const save = (setting: ServeSetting) =>
          Effect.try({
            try: () => settings.write(setting),
            catch: () => new RemoteRefused({ message: "Couldn't save the setting" }),
          });
        /**
         * Gram's own listener: its one `/` proxy pointing at this run or the target Gram saved, and
         * never one shared with Funnel, which only the user turns on.
         */
        const ours = (listener: ServeListener | undefined, owned: string | undefined) =>
          listener !== undefined &&
          !listener.funnel &&
          listener.handlers === 1 &&
          listener.proxy !== undefined &&
          (listener.proxy === target || listener.proxy === owned);

        /**
         * Adds or re-points Gram's listener on `port`, refusing a port anything else holds. The
         * target is saved before Tailscale is asked, so a listener Gram added is always one it
         * can recognise later, even after a crash.
         */
        const serve = (dnsName: string, port: number, saved: ServeSetting | undefined) =>
          Effect.gen(function* () {
            const listeners = yield* serveListeners(tailscale, dnsName);
            if (listeners === undefined)
              return yield* Effect.fail(
                new RemoteRefused({ message: "Tailscale Serve didn't answer", transient: true }),
              );
            const held = listeners.find((listener) => listener.port === port);
            if (held?.funnel) return yield* refused(`Port ${port} is shared publicly with Funnel`);
            const owned = saved?.port === port ? saved.target : undefined;
            if (held !== undefined && !ours(held, owned))
              return yield* refused(`Another Tailscale Serve listener uses port ${port}`);
            // Unchanged on a recheck, so serving steadily doesn't rewrite the file each time.
            if (saved?.enabled !== true || saved.port !== port || saved.target !== target)
              yield* save({ enabled: true, port, target });
            // Before asking, so an interrupted ask still leaves the finalizer to check the port.
            applied = port;
            if (held?.proxy === target) return;
            const result = yield* tailscale.run(["serve", "--bg", `--https=${port}`, target]).pipe(
              Effect.catchTag("TailscaleMissing", () =>
                refused(stateMessage({ state: "missing" })),
              ),
              Effect.tapError(() => restore(saved)),
            );
            if (result.code !== 0) {
              yield* restore(saved);
              const consent = /https:\/\/login\.tailscale\.com\/\S+/.exec(
                `${result.stdout}\n${result.stderr}`,
              )?.[0];
              return yield* refused(
                consent === undefined
                  ? "Tailscale refused to serve Gram"
                  : `Allow Tailscale Serve for this tailnet at ${consent}`,
              );
            }
          });
        /** Puts back the setting a refused turn-on replaced, keeping what it already owned. */
        const restore = (saved: ServeSetting | undefined) =>
          Effect.sync(() => {
            try {
              settings.write(saved ?? { enabled: false, port: SERVE_PORTS[0] });
            } catch {
              /* The target written stays recorded, which only lets Gram recognise its own. */
            }
          });

        /** Removes Gram's listener on `port`, only while it is still Gram's alone. */
        const unserve = (port: number, owned: string | undefined) =>
          Effect.gen(function* () {
            const state = yield* probe(true);
            if (state.state !== "ready" && state.state !== "no-https")
              return yield* refused(
                `${stateMessage(state)}, so Gram couldn't remove its Serve listener on port ${port}`,
              );
            const listeners = yield* serveListeners(tailscale, state.dnsName);
            if (listeners === undefined) return yield* refused("Tailscale Serve didn't answer");
            if (
              !ours(
                listeners.find((listener) => listener.port === port),
                owned,
              )
            ) {
              if (applied === port) applied = undefined;
              return;
            }
            const result = yield* tailscale
              .run(["serve", `--https=${port}`, "off"])
              .pipe(
                Effect.catchTag("TailscaleMissing", () =>
                  refused(stateMessage({ state: "missing" })),
                ),
              );
            if (result.code !== 0)
              return yield* refused(
                `Tailscale didn't remove Gram's Serve listener on port ${port}`,
              );
            if (applied === port) applied = undefined;
          });

        /** Serves access on `dnsName`, replacing access open on any other address. */
        const open = (dnsName: string, port: number) => {
          const origin = originFor(dnsName, port);
          if (access?.origin === origin) return;
          setAccess(
            createRemoteAccess(
              origin,
              port,
              Date.now,
              fileRemoteSessionStore(config.dataDir, origin, port),
            ),
          );
        };

        const pickPort = (dnsName: string, requested: number | undefined, saved?: ServeSetting) =>
          Effect.gen(function* () {
            if (requested !== undefined) return requested;
            if (saved !== undefined) return saved.port;
            const listeners = (yield* serveListeners(tailscale, dnsName)) ?? [];
            return (
              SERVE_PORTS.find((port) => !listeners.some((listener) => listener.port === port)) ??
              SERVE_PORTS[0]
            );
          });

        /** On as the user left it: turned on, and not turned off since, saved or not. */
        const switchedOn = (saved: ServeSetting | undefined) =>
          !wantOff && (access !== undefined || saved?.enabled === true);

        const statusNow = Effect.gen(function* () {
          const state = yield* probe();
          const saved = readSetting();
          // Still on while a turn-off waits to remove the listener.
          const on = turningOff !== undefined || switchedOn(saved);
          // Tailscale is back while recovery waits out its backoff: try now, not in a minute.
          if (on && state.state === "ready" && recoverySaw !== undefined && recoverySaw !== "ready")
            wake();
          const port =
            access !== undefined ? portOf(access.origin) : (saved?.port ?? SERVE_PORTS[0]);
          const shown = on && turningOff === undefined ? (downMessage(state) ?? problem) : problem;
          return {
            mode: on ? "on" : "off",
            tailscale: state,
            port,
            ...(access === undefined ? {} : { origin: access.origin }),
            devices: access?.devices() ?? [],
            ...(access === undefined ? {} : pairingOf(access)),
            ...(shown === undefined ? {} : { problem: shown }),
          } satisfies RemoteAccessStatus;
        });

        const dialAccess = (): DialAccess => {
          if (turningOff !== undefined || !switchedOn(readSetting())) return "off";
          const state = tailscaleSeen?.state;
          if (state !== undefined && state.state !== "ready") return state.state;
          return problem === undefined && access !== undefined ? "on" : "serve";
        };

        // A dead loopback port could be reused by another program, which Serve would then share
        // with the tailnet. Take the listener down with the server; startup puts it back. Added
        // before the startup fiber, so that fiber is interrupted before this waits for the lock.
        yield* Effect.addFinalizer(() =>
          lock
            .withPermits(1)(
              Effect.suspend(() => {
                // Browsers only: joined machines are the host registry's to close on shutdown.
                access?.disconnectAll();
                const port = applied;
                if (port === undefined) return Effect.void;
                return Effect.gen(function* () {
                  const state = yield* probe();
                  if (state.state !== "ready" && state.state !== "no-https") return;
                  const listeners = yield* serveListeners(tailscale, state.dnsName);
                  if (
                    !ours(
                      listeners?.find((listener) => listener.port === port),
                      undefined,
                    )
                  )
                    return;
                  yield* tailscale.run(["serve", `--https=${port}`, "off"]);
                });
              }),
            )
            // Inside the desktop shell's 10 s stop deadline, waiting out a CLI call in progress.
            .pipe(Effect.timeout(8000), Effect.ignore),
        );

        /**
         * One look while the switch is on: serve on this run's port when Tailscale is ready, taking
         * back a listener Gram left on an earlier run's port, or finish a turn-off that couldn't
         * remove its listener. `retry` when it couldn't, so the next look comes sooner.
         */
        const recoverOnce = lock.withPermits(1)(
          Effect.gen(function* () {
            if (turningOff !== undefined) {
              const { port, owned } = turningOff;
              yield* unserve(port, owned);
              turningOff = undefined;
              problem = undefined;
              const saved = readSetting();
              if (saved !== undefined)
                yield* save({ ...saved, enabled: false }).pipe(
                  Effect.catchTag("RemoteRefused", () =>
                    Effect.sync(() => {
                      problem = OFF_UNSAVED;
                    }),
                  ),
                );
              return "ok" as const;
            }
            const saved = readSetting();
            if (!switchedOn(saved)) {
              recoverySaw = undefined;
              return "idle" as const;
            }
            const state = yield* probe(true);
            recoverySaw = state.state;
            if (state.state !== "ready") {
              // Unavailable: nothing is authorized on an address Tailscale isn't serving. One look
              // that went unanswered is borne, as the CLI can be slow.
              if (state.state !== "error" || ++unanswered > 1) setAccess(undefined);
              return "retry" as const;
            }
            const port =
              access !== undefined ? portOf(access.origin) : (saved?.port ?? SERVE_PORTS[0]);
            // Tailscale answered with another name: the old address is gone for certain, whatever
            // Serve says next, so access on it closes now and opens on the new one once served.
            if (access !== undefined && access.origin !== originFor(state.dnsName, port))
              setAccess(undefined);
            yield* serve(state.dnsName, port, saved);
            // On this run's port, and on the tailnet name Tailscale reports now.
            open(state.dnsName, port);
            unanswered = 0;
            problem = undefined;
            return "ok" as const;
          }).pipe(
            Effect.catchTag("RemoteRefused", (error) =>
              Effect.sync(() => {
                problem = error.message;
                if (error.transient !== true || ++unanswered > 1) setAccess(undefined);
                return "retry" as const;
              }),
            ),
          ),
        );

        // Off the boot path: the first look re-points a listener Settings turned on to this run's
        // port; later ones bring it back after Tailscale stops, signs out or loses the listener.
        yield* Effect.gen(function* () {
          let failures = 0;
          while (true) {
            wakeRecovery = Deferred.makeUnsafe<void>();
            const outcome = yield* recoverOnce;
            failures = outcome === "retry" ? failures + 1 : 0;
            const delay =
              failures === 0
                ? RECHECK_MS
                : (RECOVERY_DELAYS_MS[Math.min(failures, RECOVERY_DELAYS_MS.length) - 1] ??
                  RECHECK_MS);
            yield* Effect.raceFirst(Effect.sleep(delay), Deferred.await(wakeRecovery));
          }
        }).pipe(Effect.forkScoped);

        return RemoteControl.of({
          current: () => access,
          dialAccess,
          watch: (listener) => {
            watchers.add(listener);
            if (access !== undefined) listener(access.origin);
            return () => {
              watchers.delete(listener);
            };
          },
          status: statusNow,
          enable: (requested) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const state = yield* probe(true);
                if (state.state !== "ready") return yield* refused(stateMessage(state));
                const saved = readSetting();
                const port = yield* pickPort(state.dnsName, requested, saved);
                if (access !== undefined && portOf(access.origin) !== port)
                  return yield* refused("Turn phone access off before changing its port");
                // A listener left on the old port (a failed start) goes first, while Gram can
                // still recognise it by its saved target.
                if (access === undefined && saved !== undefined && saved.port !== port)
                  yield* unserve(saved.port, saved.target);
                yield* serve(state.dnsName, port, saved);
                wantOff = false;
                open(state.dnsName, port);
                problem = undefined;
                unanswered = 0;
                turningOff = undefined;
                recoverySaw = state.state;
                return yield* statusNow;
              }),
            ),
          disable: lock.withPermits(1)(
            Effect.gen(function* () {
              const saved = readSetting();
              const current = access;
              // First, so nothing serves again whatever fails below.
              wantOff = true;
              setAccess(undefined);
              problem = undefined;
              const port =
                current !== undefined ? portOf(current.origin) : (turningOff?.port ?? saved?.port);
              // Off first: a setting that fails to save must not leave the listener up.
              if (
                port !== undefined &&
                (current !== undefined || saved?.enabled === true || turningOff !== undefined)
              ) {
                const owned = saved?.port === port ? saved.target : turningOff?.owned;
                // Kept on when the listener stays up, so the status says so; recovery keeps
                // trying to remove it.
                yield* unserve(port, owned).pipe(
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      problem = error.message;
                      turningOff = { port, owned };
                      // Retried from the first backoff step, not after a quiet minute.
                      wake();
                    }),
                  ),
                );
              }
              turningOff = undefined;
              if (saved !== undefined)
                yield* save({ ...saved, enabled: false }).pipe(
                  Effect.mapError(() => new RemoteRefused({ message: OFF_UNSAVED })),
                );
              return yield* statusNow;
            }),
          ),
        });
      }),
    );
}

const pairingOf = (access: RemoteAccess) => {
  const pairing = access.pairing();
  return pairing === undefined ? {} : { pairing };
};
