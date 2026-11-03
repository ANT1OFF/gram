/**
 * The releases a package or tool has published, for the condition wakes that wait on a new one:
 * every version with its publish time. Gram asks through the user's own tools and nothing else:
 * npm's registry through the user's npm (`npm view <name> time versions --json`, so npm applies its
 * own registry, proxy and cache, and Gram never reads `.npmrc`), and a GitHub repo's releases
 * through the user's gh (`gh api repos/<owner>/<repo>/releases` on github.com), paced to the
 * background share of the allowance like the other polls. Neither sends anything of Gram's beyond
 * the name asked about; neither's error text is kept or logged, since npm's can name its registry.
 */
import { homedir } from "node:os";
import { ghApi, Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { asBackground, GhBudget } from "../github/budget.ts";

/** One published version. */
export interface UpstreamRelease {
  /** `1.2.3` or `1.2.3-beta.1`, without a leading `v`. */
  readonly version: string;
  /** Epoch ms it was published. */
  readonly publishedAt: number;
  readonly url: string;
  /** A semver prerelease, or one GitHub marks as a prerelease. */
  readonly prerelease: boolean;
}

export type ReleaseSource = "npm" | "github";

export interface UpstreamReleasesShape {
  /**
   * The name's published versions, in no particular order; `null` when the registry or GitHub says
   * there is no such package or repo, `undefined` when it couldn't be read (offline, npm or gh
   * missing, rate-limited, out of the background allowance).
   */
  readonly list: (
    source: ReleaseSource,
    name: string,
  ) => Effect.Effect<ReadonlyArray<UpstreamRelease> | null | undefined>;
}

export class UpstreamReleases extends Context.Service<UpstreamReleases, UpstreamReleasesShape>()(
  "@gram/server/UpstreamReleases",
) {}

/** The first `x.y.z` in a tag (`v1.2.3`, `rust-v0.166.0`), with a prerelease suffix if it has one. */
export const versionOfTag = (tag: string): string | undefined =>
  /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(tag)?.[1];

const isSemverPrerelease = (version: string) => /^\d+\.\d+\.\d+-/.test(version);

/** One read may take this long: a cold packument of a long-lived package takes a while. */
const READ_TIMEOUT_MS = 2 * 60_000;
/** Every version's publish time of a package with thousands of them fits in this. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const decodeNpm = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      time: Schema.Record(Schema.String, Schema.String),
      // One version is printed as a string, more as a list.
      versions: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    }),
  ),
);

const decodeGithub = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        tag_name: Schema.String,
        html_url: Schema.String,
        published_at: Schema.NullOr(Schema.String),
        prerelease: Schema.Boolean,
        draft: Schema.Boolean,
      }),
    ),
  ),
);

/** `npm view --json`'s answer: the versions still published, with their times. */
export const npmReleases = (
  name: string,
  stdout: string,
): ReadonlyArray<UpstreamRelease> | undefined => {
  const parsed = Option.getOrUndefined(decodeNpm(stdout));
  if (parsed === undefined) return undefined;
  const versions = typeof parsed.versions === "string" ? [parsed.versions] : parsed.versions;
  return versions.flatMap((version) => {
    const publishedAt = Date.parse(parsed.time[version] ?? "");
    if (Number.isNaN(publishedAt)) return [];
    return [
      {
        version,
        publishedAt,
        url: `https://www.npmjs.com/package/${name}/v/${version}`,
        prerelease: isSemverPrerelease(version),
      },
    ];
  });
};

/** The releases endpoint's answer, without drafts or tags that name no version. */
export const githubReleases = (stdout: string): ReadonlyArray<UpstreamRelease> | undefined => {
  const parsed = Option.getOrUndefined(decodeGithub(stdout));
  if (parsed === undefined) return undefined;
  return parsed.flatMap((release) => {
    const version = versionOfTag(release.tag_name);
    const publishedAt = Date.parse(release.published_at ?? "");
    if (release.draft || version === undefined || Number.isNaN(publishedAt)) return [];
    return [
      {
        version,
        publishedAt,
        url: release.html_url,
        prerelease: release.prerelease || isSemverPrerelease(version),
      },
    ];
  });
};

/** npm or GitHub says there is no such package or repo. */
const NOT_FOUND = /\bE404\b|not found|HTTP 404/i;

export const UpstreamReleasesLive = Layer.effect(
  UpstreamReleases,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const budget = yield* GhBudget;
    const cwd = homedir();
    const npm = (name: string) =>
      proc
        .run("npm", ["view", "--json", name, "time", "versions"], {
          cwd,
          timeoutMs: READ_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        })
        .pipe(
          Effect.map((out) => {
            if (out.status !== 0) return NOT_FOUND.test(out.stderr) ? null : undefined;
            if (out.truncated) return undefined;
            return npmReleases(name, out.stdout);
          }),
          Effect.orElseSucceed(() => undefined),
        );
    const github = (repo: string) =>
      Effect.gen(function* () {
        if (!(yield* budget.admit("core", "background")).allowed) return undefined;
        return yield* ghApi(
          cwd,
          [`repos/${repo}/releases?per_page=30`, "--hostname", "github.com"],
          {
            timeoutMs: READ_TIMEOUT_MS,
            maxOutputBytes: MAX_OUTPUT_BYTES,
          },
        ).pipe(
          Effect.provideService(Proc, proc),
          asBackground,
          Effect.map((out) => {
            if (out.status !== 0) return NOT_FOUND.test(out.stderr) ? null : undefined;
            if (out.truncated) return undefined;
            return githubReleases(out.stdout);
          }),
          Effect.orElseSucceed(() => undefined),
        );
      });
    return UpstreamReleases.of({
      list: (source, name) => (source === "npm" ? npm(name) : github(name)),
    });
  }),
);
