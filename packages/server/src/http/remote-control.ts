import { execFile } from "node:child_process";
import type { RemoteAccessStatus, TailscaleState } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { HttpServer } from "../platform/unstable.ts";
import { ServerConfig } from "../config.ts";
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

export const originFor = (dnsName: string, port: number): string =>
  port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;

/** One HTTPS Serve listener as `tailscale serve status --json` reports it. */
export interface ServeListener {
  readonly port: number;
  /** The `/` handler's proxy target, when it is a proxy. */
  readonly proxy: string | undefined;
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
        const handler = record(record(record(web[`${dnsName}:${port}`])["Handlers"])["/"]);
        const proxy = handler["Proxy"];
        return {
          port,
          proxy: typeof proxy === "string" ? proxy : undefined,
          funnel: funnel[`${dnsName}:${port}`] === true,
        };
      });
    }),
    Effect.catchTag("TailscaleMissing", () => Effect.succeed(undefined)),
  );

/** The ports Gram tries, in order, when it picks one itself. */
export const SERVE_PORTS = [9443, 9444, 9445, 9446, 8443] as const;
const GRAM_PROXY = /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/;

export class RemoteRefused extends Data.TaggedError("RemoteRefused")<{
  readonly message: string;
}> {}

interface ServeSetting {
  readonly enabled: boolean;
  readonly port: number;
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
        Number(saved["port"]) > 65535
      )
        throw new Error("Remote access storage is invalid");
      return { enabled: saved["enabled"], port: Number(saved["port"]) };
    },
    write: (setting: ServeSetting) => file.write({ version: 1, ...setting }),
  };
};

export interface RemoteControlShape {
  /** The remote access serving right now, if any; read on every request. */
  readonly current: () => RemoteAccess | undefined;
  readonly status: Effect.Effect<RemoteAccessStatus>;
  /** Turns phone access on through Tailscale Serve, on `port` or one Gram picks. */
  readonly enable: (port?: number) => Effect.Effect<RemoteAccessStatus, RemoteRefused>;
  /** Removes Gram's Serve listener and closes remote connections; pairings are kept. */
  readonly disable: Effect.Effect<RemoteAccessStatus, RemoteRefused>;
}

const refused = (message: string) => Effect.fail(new RemoteRefused({ message }));

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
        const tailscale = yield* Tailscale;
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
        let problem: string | undefined;
        let tailscaleSeen: { at: number; state: TailscaleState } | undefined;
        const probe = (fresh = false) =>
          Effect.gen(function* () {
            if (!fresh && tailscaleSeen !== undefined && Date.now() - tailscaleSeen.at < 15_000)
              return tailscaleSeen.state;
            const state = yield* tailscaleState(tailscale);
            tailscaleSeen = { at: Date.now(), state };
            return state;
          });
        const readSetting = () => {
          try {
            return settings.read();
          } catch {
            return undefined;
          }
        };
        const target = `http://127.0.0.1:${loopback}`;

        /** Adds or re-points Gram's listener on `port`; refuses a port anything else holds. */
        const serve = (dnsName: string, port: number, ownedPort: number | undefined) =>
          Effect.gen(function* () {
            const listeners = yield* serveListeners(tailscale, dnsName);
            if (listeners === undefined) return yield* refused("Tailscale Serve didn't answer");
            const held = listeners.find((listener) => listener.port === port);
            if (held?.funnel) return yield* refused(`Port ${port} is shared publicly with Funnel`);
            if (
              held !== undefined &&
              !(ownedPort === port && held.proxy !== undefined && GRAM_PROXY.test(held.proxy))
            )
              return yield* refused(`Another Tailscale Serve listener uses port ${port}`);
            if (held?.proxy?.replace(/\/$/, "") === target) return;
            const result = yield* tailscale
              .run(["serve", "--bg", `--https=${port}`, target])
              .pipe(
                Effect.catchTag("TailscaleMissing", () =>
                  refused(stateMessage({ state: "missing" })),
                ),
              );
            if (result.code !== 0) {
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

        const open = (dnsName: string, port: number) => {
          const origin = originFor(dnsName, port);
          access = createRemoteAccess(
            origin,
            port,
            Date.now,
            fileRemoteSessionStore(config.dataDir, origin, port),
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

        const statusNow = Effect.gen(function* () {
          const state = yield* probe();
          const saved = readSetting();
          const port =
            access !== undefined
              ? Number(new URL(access.origin).port || 443)
              : (saved?.port ?? SERVE_PORTS[0]);
          return {
            mode: access !== undefined || saved?.enabled === true ? "on" : "off",
            tailscale: state,
            port,
            ...(access === undefined ? {} : { origin: access.origin }),
            devices: access?.devices() ?? [],
            ...(access === undefined ? {} : pairingOf(access)),
            ...(problem === undefined ? {} : { problem }),
          } satisfies RemoteAccessStatus;
        });

        // Re-point a listener Settings turned on to this run's port, off the boot path.
        yield* lock
          .withPermits(1)(
            Effect.gen(function* () {
              const saved = readSetting();
              if (saved?.enabled !== true) return;
              const state = yield* probe(true);
              if (state.state !== "ready") {
                problem = stateMessage(state);
                return;
              }
              yield* serve(state.dnsName, saved.port, saved.port);
              open(state.dnsName, saved.port);
            }).pipe(
              Effect.catchTag("RemoteRefused", (error) =>
                Effect.sync(() => {
                  problem = error.message;
                }),
              ),
            ),
          )
          .pipe(Effect.forkScoped);

        // A dead loopback port could be reused by another program, which Serve would then share
        // with the tailnet. Take the listener down with the server; startup puts it back.
        yield* Effect.addFinalizer(() =>
          Effect.suspend(() => {
            if (access === undefined) return Effect.void;
            access.disconnectAll();
            const port = Number(new URL(access.origin).port || 443);
            return tailscale
              .run(["serve", `--https=${port}`, "off"])
              .pipe(Effect.timeout(3000), Effect.ignore);
          }),
        );

        return RemoteControl.of({
          current: () => access,
          status: statusNow,
          enable: (requested) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                const state = yield* probe(true);
                if (state.state !== "ready") return yield* refused(stateMessage(state));
                const saved = readSetting();
                const port = yield* pickPort(state.dnsName, requested, saved);
                const owned =
                  access !== undefined || saved?.enabled === true ? saved?.port : undefined;
                if (access !== undefined && saved?.port !== port)
                  return yield* refused("Turn phone access off before changing its port");
                yield* serve(state.dnsName, port, owned);
                yield* Effect.try({
                  try: () => settings.write({ enabled: true, port }),
                  catch: () => new RemoteRefused({ message: "Couldn't save the setting" }),
                });
                if (access === undefined) open(state.dnsName, port);
                problem = undefined;
                return yield* statusNow;
              }),
            ),
          disable: lock.withPermits(1)(
            Effect.gen(function* () {
              const saved = readSetting();
              const current = access;
              access = undefined;
              problem = undefined;
              current?.disconnectAll();
              if (saved !== undefined)
                yield* Effect.try({
                  try: () => settings.write({ enabled: false, port: saved.port }),
                  catch: () => new RemoteRefused({ message: "Couldn't save the setting" }),
                });
              const port =
                current !== undefined ? Number(new URL(current.origin).port || 443) : saved?.port;
              if (port !== undefined && (current !== undefined || saved?.enabled === true)) {
                const state = yield* probe(true);
                const listeners =
                  state.state === "ready" || state.state === "no-https"
                    ? yield* serveListeners(tailscale, state.dnsName)
                    : undefined;
                const held = listeners?.find((listener) => listener.port === port);
                // Only ever remove the listener Gram added.
                if (held?.proxy !== undefined && GRAM_PROXY.test(held.proxy))
                  yield* tailscale
                    .run(["serve", `--https=${port}`, "off"])
                    .pipe(Effect.catchTag("TailscaleMissing", () => Effect.void));
              }
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
