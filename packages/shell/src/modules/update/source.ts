// Where the updater learns of releases and gets an installer onto disk. The
// selection, the checks against the saved settings, and the signature verification are the
// updater's; the source only reads and fetches.

import type { ProcessResult, RunGh } from "./updater.ts";

/** One release as a source reports it: its tag, whether it is a draft, and its assets' names. */
export interface SourceRelease {
  readonly tagName: unknown;
  readonly isDraft: unknown;
  readonly assets: string[];
}

/** Where the updater reads releases from: the GitHub CLI (`ghReleaseSource`). */
export interface ReleaseSource {
  /** Whether releases can be read now: `gh` is signed in. */
  ready(): Promise<boolean>;
  /**
   * Releases as `{ tagName, isDraft }` records, newest first, as `gh release list --json` gives
   * them; `undefined`, with a warning, when the source failed or said something unparseable.
   */
  list(): Promise<readonly unknown[] | undefined>;
  /** One release, read again; `undefined`, with a warning, when the source failed. */
  view(tag: string): Promise<SourceRelease | undefined>;
  /** The release's page, for the macOS notify-and-link path; `""` when the source has none. */
  pageUrl(tag: string): Promise<string>;
  /** Puts `asset` of `tag` into `dir`, and nothing else; rejects with why it couldn't. */
  download(tag: string, asset: string, dir: string): Promise<void>;
  /** What an install says when `ready` is false. */
  readonly notReadyMessage: string;
}

const READY_TTL_MS = 300_000;
const NOT_READY_TTL_MS = 15_000;

/** The GitHub CLI, signed in as the user, against `repo`. */
export function ghReleaseSource(options: {
  readonly gh: RunGh;
  readonly repo: string;
  /** An existing dir for `gh` to run in. */
  readonly tempDir: string;
  readonly warn: (message: string) => void;
  readonly now?: (() => number) | undefined;
}): ReleaseSource {
  const { gh, repo, tempDir, warn } = options;
  const now = options.now ?? Date.now;
  let readiness: { at: number; ready: boolean } | undefined;

  const run = (
    args: readonly string[],
    cwd = tempDir,
    timeoutMs = 10_000,
  ): Promise<ProcessResult> => gh(args, { cwd, timeoutMs });

  return {
    notReadyMessage: "GitHub CLI (gh) is not installed or not authenticated",

    // `gh auth status` is slow, so its answer is cached, briefly when it says no.
    async ready() {
      if (readiness && now() - readiness.at < (readiness.ready ? READY_TTL_MS : NOT_READY_TTL_MS)) {
        return readiness.ready;
      }
      const result = await run(["auth", "status"], tempDir, 8_000);
      readiness = { at: now(), ready: result.status === 0 };
      return readiness.ready;
    },

    async list() {
      const out = await run([
        "release",
        "list",
        "--repo",
        repo,
        "--limit",
        "30",
        "--json",
        "tagName,isDraft",
      ]);
      if (out.status !== 0) {
        warn(`update check: gh release list failed: ${out.stderr.trim()}`);
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.stdout.trim());
      } catch (error) {
        warn(`update check: could not parse gh output: ${String(error)}`);
        return undefined;
      }
      if (!Array.isArray(parsed)) {
        warn("update check: gh output is not a list");
        return undefined;
      }
      return parsed;
    },

    async view(tag) {
      const out = await run([
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "tagName,isDraft,assets",
      ]);
      if (out.status !== 0) {
        warn(`update: gh release view ${tag} failed: ${out.stderr.trim()}`);
        return undefined;
      }
      try {
        const view = JSON.parse(out.stdout.trim()) as Record<string, unknown> | null;
        const assets: unknown = view?.["assets"];
        if (!Array.isArray(assets)) throw new Error("no assets list");
        return {
          tagName: view?.["tagName"],
          isDraft: view?.["isDraft"],
          assets: assets.flatMap((asset: unknown) => {
            const name: unknown = (asset as { name?: unknown } | null)?.name;
            return typeof name === "string" ? [name] : [];
          }),
        };
      } catch (error) {
        warn(`update: could not parse gh release view ${tag}: ${String(error)}`);
        return undefined;
      }
    },

    async pageUrl(tag) {
      const out = await run(["release", "view", tag, "--repo", repo, "--json", "url"]);
      if (out.status !== 0) return "";
      try {
        const url: unknown = (JSON.parse(out.stdout.trim()) as { url?: unknown }).url;
        return typeof url === "string" ? url : "";
      } catch {
        return "";
      }
    },

    async download(tag, asset, dir) {
      const out = await run(
        ["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", dir, "--clobber"],
        dir,
        180_000,
      );
      if (out.status !== 0) throw new Error(`download failed: ${out.stderr.trim()}`);
    },
  };
}
