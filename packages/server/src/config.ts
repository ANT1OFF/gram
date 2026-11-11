import {
  featureAvailable,
  featureRefusal,
  InvalidState,
  type RuntimeFeatureId,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { embedFromEnv, scrubEmbedSecrets, type EmbedConfigShape } from "./embedding/config.ts";
import { frontedIdentityFrom, type FrontedIdentityConfig } from "./http/fronted-identity.ts";
import { remoteOrigin } from "./http/remote-access.ts";
import { type ProvisionedHostsConfig, provisionedHostsFrom } from "./host/provisioned.ts";
import { defaultDataDir } from "./logging/data-dir.ts";

/** An endpoint outside the server that an embedding deployment points it at. */
export interface EndpointConfig {
  /** An `http:` or `https:` URL. */
  readonly url: string;
  /** Sent as `Authorization: Bearer`; never logged. */
  readonly token?: string;
}

/** `url` as an endpoint, or `undefined` for anything but a whole `http(s)` URL without credentials. */
export const endpointFrom = (
  url: string | undefined,
  token: string | undefined,
): EndpointConfig | undefined => {
  if (url === undefined || url.trim() === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // A credential belongs in the token, which is never logged; a URL is.
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.hash !== "") return undefined;
  // A token is one header value: printable, with no spaces. Anything else can't be sent, and the
  // error for it would quote it.
  if (token && !/^[\x21-\x7e]+$/.test(token)) return undefined;
  return { url: parsed.toString(), ...(token ? { token } : {}) };
};

/** An endpoint that was configured but can't be used, which is not the same as none. */
export const ENDPOINT_UNUSABLE = "unusable";
export type EndpointSetting = EndpointConfig | typeof ENDPOINT_UNUSABLE;

/** `endpointFrom`, telling a URL that was given and can't be used from one that wasn't given. */
export const endpointSetting = (
  url: string | undefined,
  token: string | undefined,
): EndpointSetting | undefined =>
  url === undefined || url.trim() === ""
    ? undefined
    : (endpointFrom(url, token) ?? ENDPOINT_UNUSABLE);

export interface ServerConfigShape {
  /** Directory holding the database (`DATABASE_FILE`) and logs. */
  readonly dataDir: string;
  /** Overrides `<dataDir>/gram-v1.db`; `:memory:` in tests. */
  readonly databaseFile?: string;
  /** `0` picks a free port. */
  readonly port: number;
  /**
   * The address the server listens on: loopback, unless it runs in a container
   * (`GRAM_CONTAINER=1`), where `GRAM_LISTEN_HOST=0.0.0.0` lets the container's port mapping reach
   * it. Requests still need a loopback `Host` and the launch cookie either way.
   */
  readonly listenHost?: string;
  /** Built web app to serve; absent in dev, where Vite serves the renderer. */
  readonly webRoot: string | undefined;
  /** Extra `Origin`s allowed past the loopback allowlist (dev tooling only). */
  readonly extraOrigins: ReadonlyArray<string>;
  /** Explicit HTTPS Tailscale Serve origin; absent keeps remote access disabled. */
  readonly remoteOrigin?: string;
  /**
   * The listener provisioned hosts dial over TLS (`host/provisioned.ts`); absent, as it is unless
   * its environment is set, there is none and no host can be provisioned.
   */
  readonly provisionedHosts?: ProvisionedHostsConfig;
  /**
   * Sign-in by a fronting proxy's signed statements (`http/fronted-identity.ts`), as the
   * environment configures it; used only while the hosted features setting is on.
   */
  readonly frontedIdentity?: FrontedIdentityConfig;
  /** Overrides the `agents.idleEvictMinutes` setting when set. */
  readonly idleEvictAfter: Duration.Duration | undefined;
  readonly interruptWatchdog: Duration.Duration;
  /** How long an agent may retry one turn before it is stopped; 10 minutes when absent. */
  readonly retryDeadline?: Duration.Duration | undefined;
  /** The app version: Electron's `app.getVersion()` in the desktop shell. */
  readonly appVersion?: string;
  /**
   * Which build of it runs: the source commit a packaged build was made from, or `dev` for one run
   * from source (`GRAM_APP_BUILD`, set by the desktop shell).
   */
  readonly appBuild?: string;
  /**
   * Set under the desktop shell, which opens links itself after its own link dialog, so
   * `app.openExternal` refuses rather than open a link past that question.
   */
  readonly shellOpensLinks?: boolean;
  /**
   * The echo fake agent replaces real agents (`GRAM_FAKE_AGENT=1`). The desktop shell withholds the
   * variable from a packaged build (`apps/desktop/src/main/server-env.ts`).
   */
  readonly fakeAgent?: boolean;
  /**
   * How long wake reasons collect before an orchestrator gets its digest; a minute when absent.
   * `GRAM_ORCHESTRATION_DEBOUNCE_MS` shortens it so the e2e flows don't wait it out.
   */
  readonly orchestrationDebounce?: Duration.Duration;
  /**
   * `GRAM_EMBEDDING`: `1` turns the hosted features setting (`experimental.embedding`) on when the
   * server starts and `0` turns it off, for a server with no window to change it in. Absent leaves
   * the stored setting as it is.
   */
  readonly embedding?: boolean;
  /**
   * The outside services an embedding deployment configured (`embedding/config.ts`). Inert until
   * the hosted features setting is on.
   */
  readonly embed?: EmbedConfigShape;
  /**
   * `GRAM_HEADLESS=1`: a control plane with no agent host of its own. Every session, an
   * orchestrator's included, runs on a joined machine, and nothing is started on this one: no
   * agent, no terminal, no worktree. One of the hosted features, so the server refuses to start
   * this way unless they are on (`host/headless.ts`).
   */
  readonly headless?: boolean;
  /**
   * Asked before each outward action (`embedding/decision-hook.ts`): `GRAM_DECISION_HOOK_URL`,
   * with `GRAM_DECISION_HOOK_TOKEN`. Absent, nothing is asked. Given but unusable, everything
   * the hook would be asked about is refused: a mistyped URL must not turn the hook off.
   */
  readonly decisionHook?: EndpointSetting;
  /**
   * Sent what happens, in order (`embedding/event-sink.ts`): `GRAM_EVENT_SINK_URL`, with
   * `GRAM_EVENT_SINK_TOKEN`. Absent or unusable, nothing is recorded or sent.
   */
  readonly eventSink?: EndpointSetting;
}

/**
 * The running app as an orchestrator is shown it, `0.4.0 (1a2b3c4)` or `0.4.0 (dev)`, so it can tell
 * whether a merged fix is live yet; undefined when the version isn't known.
 */
export const appLabelOf = (
  config: Pick<ServerConfigShape, "appVersion" | "appBuild">,
): string | undefined =>
  config.appVersion === undefined
    ? undefined
    : `${config.appVersion}${config.appBuild === undefined ? "" : ` (${config.appBuild.slice(0, 7)})`}`;

/** Refuses an unavailable app feature even when a caller bypasses the UI's visibility gate. */
export const refuseUnavailable = (feature: RuntimeFeatureId): Effect.Effect<void, InvalidState> =>
  featureAvailable(feature, {})
    ? Effect.void
    : Effect.fail(new InvalidState({ message: featureRefusal(feature) }));

/** Loopback, the only address a server outside a container listens on. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * `GRAM_LISTEN_HOST`, honoured only inside a container (`GRAM_CONTAINER=1`, which the image sets)
 * and only as all interfaces, which the container's own network keeps off the machine's: a port
 * mapped to the host's loopback is the only way in. Anywhere else, or any other value, listens on
 * loopback.
 */
export const listenHostFrom = (env: Record<string, string | undefined>): string | undefined =>
  env["GRAM_CONTAINER"] === "1" && env["GRAM_LISTEN_HOST"] === "0.0.0.0" ? "0.0.0.0" : undefined;

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@gram/server/ServerConfig",
) {
  static readonly layer = (config: ServerConfigShape): Layer.Layer<ServerConfig> =>
    Layer.succeed(ServerConfig, config);

  /** Reads `GRAM_*` overrides from the environment. */
  static readonly fromEnv = (
    env: Record<string, string | undefined> = process.env,
  ): ServerConfigShape => {
    const port = Number.parseInt(env["GRAM_PORT"] ?? "0", 10);
    const evictMinutes = env["GRAM_IDLE_EVICT_MINUTES"];
    const appVersion = env["GRAM_APP_VERSION"] || env["npm_package_version"];
    const appBuild = env["GRAM_APP_BUILD"];
    const debounceMs = Number(env["GRAM_ORCHESTRATION_DEBOUNCE_MS"]);
    const listenHost = listenHostFrom(env);
    const embed = embedFromEnv(env);
    // Read once, here; no child process inherits them from the server's own environment.
    if (env === process.env) scrubEmbedSecrets(env);
    const provisionedHosts = provisionedHostsFrom(env);
    // Throws on a partial or malformed configuration: such a server must not start.
    const frontedIdentity = frontedIdentityFrom(env);
    const decisionHook = endpointSetting(
      env["GRAM_DECISION_HOOK_URL"],
      env["GRAM_DECISION_HOOK_TOKEN"],
    );
    const eventSink = endpointSetting(env["GRAM_EVENT_SINK_URL"], env["GRAM_EVENT_SINK_TOKEN"]);
    return {
      dataDir: defaultDataDir(env),
      ...(env["GRAM_REMOTE_ORIGIN"] !== undefined
        ? { remoteOrigin: remoteOrigin(env["GRAM_REMOTE_ORIGIN"])! }
        : {}),
      ...(provisionedHosts === undefined ? {} : { provisionedHosts }),
      port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 0,
      ...(listenHost === undefined ? {} : { listenHost }),
      ...(frontedIdentity === undefined ? {} : { frontedIdentity }),
      webRoot: env["GRAM_WEB_ROOT"] || undefined,
      extraOrigins: (env["GRAM_ALLOWED_ORIGINS"] ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o !== ""),
      idleEvictAfter:
        evictMinutes === undefined ? undefined : Duration.minutes(Number(evictMinutes)),
      interruptWatchdog: Duration.seconds(5),
      ...(appVersion ? { appVersion } : {}),
      ...(appBuild !== undefined && /^(?:[a-f0-9]{40}|dev)$/.test(appBuild) ? { appBuild } : {}),
      ...(env["GRAM_FAKE_AGENT"] === "1" ? { fakeAgent: true } : {}),
      ...(Number.isFinite(debounceMs) && debounceMs > 0
        ? { orchestrationDebounce: Duration.millis(debounceMs) }
        : {}),
      ...(env["GRAM_HEADLESS"] === "1" ? { headless: true } : {}),
      ...(env["GRAM_EMBEDDING"] === "1"
        ? { embedding: true }
        : env["GRAM_EMBEDDING"] === "0"
          ? { embedding: false }
          : {}),
      ...(embed === undefined ? {} : { embed }),
      ...(decisionHook === undefined ? {} : { decisionHook }),
      ...(eventSink === undefined ? {} : { eventSink }),
    };
  };
}
