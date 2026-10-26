import type { ReleaseCheckProblem, RuntimeAgent } from "@gram/contracts";
import type { Proc } from "@gram/git";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { npmFailure, refusedSignIn } from "./npm-registry.ts";
import { compareVersions, NPM_PACKAGES, parseSemver } from "./policy.ts";

/**
 * The newest stable release of each agent CLI, as the user's own npm sees it: `npm view <pkg>
 * dist-tags time --json` run through `Proc`, so npm applies its own registry, proxy and auth.
 * Gram never reads `.npmrc`, which
 * holds tokens, and never falls back to a registry npm wasn't configured with. Without npm there
 * is no signal, and the listing says why.
 */

/** The latest stable release of one agent. */
interface VendorRelease {
  readonly version: string;
  /** Epoch ms the registry says it was published, or when we first saw it if it didn't say. */
  readonly publishedAt: number;
}

export interface VendorReleases {
  /** Epoch ms of the last read that reached the registry; absent before one has. */
  readonly checkedAt?: number;
  readonly releases: Partial<Record<RuntimeAgent, VendorRelease>>;
  /** Why the last read couldn't check: a refused sign-in always, else when nothing could be read. */
  readonly unavailable?: ReleaseCheckProblem;
  /** A read is under way and outlasted the caller's wait; ask again for its result. */
  readonly checking?: true;
}

/** Why `npm view` gave nothing, in the listing's terms. */
export class NpmViewError extends Data.TaggedError("NpmViewError")<ReleaseCheckProblem> {}

/** `npm view <pkg> dist-tags time --json`, parsed; the live one runs the user's npm. */
export type NpmView = (pkg: string) => Effect.Effect<unknown, NpmViewError>;

/** How long one `npm view` may take: a cold packument through a slow registry can take minutes. */
export const NPM_VIEW_MS = 5 * 60_000;

/** The user's npm, from their home folder, bounded by `NPM_VIEW_MS`; its output stays unlogged. */
export const npmView =
  (proc: Proc["Service"], cwd: string): NpmView =>
  (pkg) =>
    proc
      // `npm view` fetches the whole packument whatever fields are asked for, and a cold one for
      // a measured cold Codex lookup took three minutes; npm's cache revalidates it after that.
      .run("npm", ["view", pkg, "dist-tags", "time", "--json"], { cwd, timeoutMs: NPM_VIEW_MS })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProcSpawnError"
            ? new NpmViewError({ problem: "npm-missing", message: "npm isn't installed" })
            : new NpmViewError({ problem: "unreachable", message: "npm took too long to answer" }),
        ),
        Effect.flatMap((out) => {
          // npm's own error text can name the registry it was configured with; it's read for the
          // status code only, and never kept or logged.
          if (out.status !== 0)
            return Effect.fail(
              new NpmViewError({
                problem: refusedSignIn(out.stderr) ? "sign-in" : "unreachable",
                message: npmFailure(out.stderr),
              }),
            );
          if (out.truncated)
            return Effect.fail(
              new NpmViewError({ problem: "unreachable", message: "npm's answer was too long" }),
            );
          return Effect.try({
            try: () => JSON.parse(out.stdout) as unknown,
            catch: () =>
              new NpmViewError({ problem: "unreachable", message: "npm's answer wasn't JSON" }),
          });
        }),
      );

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** The `latest` dist-tag of an `npm view … dist-tags time --json` answer, when it's a stable `x.y.z`. */
export const latestOf = (view: unknown): string | undefined => {
  const latest = record(record(view)?.["dist-tags"])?.["latest"];
  if (typeof latest !== "string") return undefined;
  const parsed = parseSemver(latest);
  return parsed !== undefined && parsed.prerelease === undefined ? latest : undefined;
};

/** When `version` was published, from the same answer's `time` map. */
export const publishedAtOf = (view: unknown, version: string): number | undefined => {
  const at = record(record(view)?.["time"])?.[version];
  const ms = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

export interface VendorReleasesConfig {
  readonly npmView: NpmView;
  readonly now: () => number;
  /** How long a read stands before the next request reads again. */
  readonly ttlMs?: number;
  /** A refresh within this long of the last read is answered from it, however often it's asked. */
  readonly minRefreshMs?: number;
}

const AGENTS: ReadonlyArray<RuntimeAgent> = ["claude", "codex"];

/**
 * The cached reader. A read runs in its own fiber in the reader's scope, so a caller that stops
 * waiting (`get`'s `waitMs`) leaves it running and a later call collects it. Concurrent callers
 * share one read; a failed agent keeps its last good release; nothing reads more often than
 * `minRefreshMs`, whatever asks.
 */
export const makeVendorReleases = (config: VendorReleasesConfig) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const ttlMs = config.ttlMs ?? 6 * 3_600_000;
    const minRefreshMs = config.minRefreshMs ?? 10 * 60_000;
    let current: VendorReleases = { releases: {} };
    let readAt: number | undefined;
    let inFlight: Fiber.Fiber<VendorReleases> | undefined;
    /** When each version was first seen, the conservative stand-in for an unknown publish time. */
    const firstSeen = new Map<string, number>();

    const readOne = (agent: RuntimeAgent) =>
      Effect.gen(function* () {
        const view = yield* config.npmView(NPM_PACKAGES[agent]);
        const version = latestOf(view);
        if (version === undefined) return undefined;
        const key = `${agent}@${version}`;
        if (!firstSeen.has(key)) firstSeen.set(key, config.now());
        // Without a publish time the wait runs from first sight, which can only be later.
        return {
          version,
          publishedAt: publishedAtOf(view, version) ?? firstSeen.get(key)!,
        } satisfies VendorRelease;
      });

    const read = Effect.gen(function* () {
      const results = yield* Effect.forEach(
        AGENTS,
        (agent) =>
          readOne(agent).pipe(
            Effect.map((release) => ({ agent, release, error: undefined })),
            Effect.catch((error) =>
              Effect.logDebug(`agent releases: ${agent}: ${error.message}`).pipe(
                Effect.as({ agent, release: undefined, error }),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
      const releases = { ...current.releases };
      let reached = false;
      for (const { agent, release } of results) {
        if (release === undefined) continue;
        reached = true;
        const previous = releases[agent];
        // A registry that briefly answers with an older `latest` doesn't take a release back.
        if (previous === undefined || !(compareVersions(release.version, previous.version) < 0))
          releases[agent] = release;
      }
      readAt = config.now();
      const checkedAt = reached ? readAt : current.checkedAt;
      // A refused sign-in is the user's to fix whatever else was read; any other failure is said
      // only when nothing could be read, as one agent's isn't a missing npm.
      const errors = results.flatMap((r) => (r.error === undefined ? [] : [r.error]));
      const failure =
        errors.find((error) => error.problem === "sign-in") ?? (reached ? undefined : errors[0]);
      current = {
        ...(checkedAt === undefined ? {} : { checkedAt }),
        releases,
        ...(failure === undefined
          ? {}
          : { unavailable: { problem: failure.problem, message: failure.message } }),
      };
      return current;
    });

    /** The releases, reading first when due; past `waitMs`, what's known now, marked `checking`. */
    const get = (refresh: boolean, waitMs?: number): Effect.Effect<VendorReleases> =>
      Effect.gen(function* () {
        const age = readAt === undefined ? Number.POSITIVE_INFINITY : config.now() - readAt;
        const due = age >= ttlMs || (refresh && age >= minRefreshMs);
        if (!due && inFlight === undefined) return current;
        inFlight ??= yield* read.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inFlight = undefined;
            }),
          ),
          Effect.forkIn(scope),
        );
        if (waitMs === undefined) return yield* Fiber.join(inFlight);
        const done = yield* Fiber.join(inFlight).pipe(Effect.timeoutOption(waitMs));
        return Option.isSome(done) ? done.value : { ...current, checking: true as const };
      });

    return { get, current: () => current };
  });
