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
import { remoteOrigin } from "./http/remote-access.ts";
import { defaultDataDir } from "./logging/data-dir.ts";

export interface ServerConfigShape {
  /** Directory holding the database (`DATABASE_FILE`) and logs. */
  readonly dataDir: string;
  /** Overrides `<dataDir>/gram-v1.db`; `:memory:` in tests. */
  readonly databaseFile?: string;
  /** `0` picks a free port. */
  readonly port: number;
  /** Built web app to serve; absent in dev, where Vite serves the renderer. */
  readonly webRoot: string | undefined;
  /** Extra `Origin`s allowed past the loopback allowlist (dev tooling only). */
  readonly extraOrigins: ReadonlyArray<string>;
  /** Explicit HTTPS Tailscale Serve origin; absent keeps remote access disabled. */
  readonly remoteOrigin?: string;
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
  /** The echo fake agent replaces real agents (`GRAM_FAKE_AGENT=1`). */
  readonly fakeAgent?: boolean;
  /**
   * How long wake reasons collect before an orchestrator gets its digest; a minute when absent.
   * `GRAM_ORCHESTRATION_DEBOUNCE_MS` shortens it so the e2e flows don't wait it out.
   */
  readonly orchestrationDebounce?: Duration.Duration;
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
    return {
      dataDir: defaultDataDir(env),
      ...(env["GRAM_REMOTE_ORIGIN"] !== undefined
        ? { remoteOrigin: remoteOrigin(env["GRAM_REMOTE_ORIGIN"])! }
        : {}),
      port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : 0,
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
    };
  };
}
