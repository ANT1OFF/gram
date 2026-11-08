import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, Proc, type ProcShape, realPathSync, WorktreeError } from "@gram/git";
import * as Effect from "effect/Effect";
import { makeKeyedLock } from "../git/keyed-lock.ts";

/** How long a clone may take before it is given up. */
const CLONE_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 2 * 60_000;

/**
 * Only the transports a repository's remote is reached over: never `file`, `ext` or the
 * unauthenticated `git` daemon, whatever a URL asks for.
 */
const GIT_ENV = {
  GIT_ALLOW_PROTOCOL: "https:ssh",
  GIT_TERMINAL_PROMPT: "0",
};

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A remote's URL as the folder the host keeps its clone in, `<host>/<owner>/<name>`, or why it
 * isn't one the host clones: `https://` without credentials in it, `ssh://`, or `user@host:path`.
 */
export const cloneFolderOf = (
  url: string,
): { readonly folder: string } | { readonly error: string } => {
  const refuse = { error: "That remote isn't an https or ssh URL the host clones." };
  if (url.length > 512 || url.startsWith("-") || /[\s\0\\]/.test(url)) return refuse;
  // Never a path that climbs or names itself, which a URL parser would quietly resolve.
  if (/(^|[/:])\.\.?(\/|$)/.test(url)) return refuse;
  let host: string;
  let path: string;
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url);
  if (url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refuse;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return refuse;
    if (parsed.protocol === "https:" && (parsed.username !== "" || parsed.password !== ""))
      return {
        error: "A remote with credentials in its URL isn't cloned; use a credential helper.",
      };
    if (parsed.search !== "" || parsed.hash !== "") return refuse;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  } else if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else return refuse;
  const segments = [host.toLowerCase(), ...path.replace(/\.git\/?$/, "").split("/")].filter(
    (segment) => segment !== "",
  );
  if (
    segments.length < 3 ||
    segments.length > 6 ||
    !segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
  )
    return refuse;
  return { folder: join(...segments) };
};

const failed = (message: string) =>
  new WorktreeError({ reason: "failed", message: message.slice(0, 400), dirty: false });

/**
 * The repositories a machine's host clones for workers placed on it, each under `root` at its
 * remote's own `<host>/<owner>/<name>`. A clone is made beside its folder and moved in once whole,
 * so one that fails leaves nothing behind; one already there is fetched, and kept only when its
 * `origin` is the URL asked for. It uses this machine's own git credentials.
 */
export const reposOn = (
  proc: ProcShape,
  root: string,
  /** Added to git's environment; tests reach a local remote through it. */
  extraEnv: Readonly<Record<string, string>> = {},
) => {
  const on = Effect.provideService(Proc, proc);
  const env = { ...GIT_ENV, ...extraEnv };
  /** One clone or fetch at a time per folder, so two workers asking at once share one clone. */
  const lock = makeKeyedLock<string>();
  const ensure = (url: string): Effect.Effect<{ readonly path: string }, WorktreeError> => {
    const target = cloneFolderOf(url);
    if ("error" in target)
      return Effect.fail(
        new WorktreeError({ reason: "invalidRequest", message: target.error, dirty: false }),
      );
    const dest = join(root, target.folder);
    return lock.withLock(
      dest,
      Effect.gen(function* () {
        if (existsSync(dest)) {
          const origin = yield* on(git(dest, ["remote", "get-url", "origin"])).pipe(
            Effect.mapError((error) => failed(error.message)),
          );
          if (origin.status !== 0 || origin.stdout.trim() !== url)
            return yield* new WorktreeError({
              reason: "conflict",
              message: `${dest} is there but isn't a clone of ${url}.`,
              dirty: false,
            });
          // A fetch that fails leaves the clone as it was: a worker can still start from it.
          yield* on(
            git(
              dest,
              ["-c", "credential.interactive=false", "fetch", "--quiet", "--prune", "origin"],
              {
                timeoutMs: FETCH_TIMEOUT_MS,
                env,
              },
            ),
          ).pipe(Effect.ignore);
          return { path: realPathSync(dest) };
        }
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        const partial = `${dest}.cloning-${randomBytes(4).toString("hex")}`;
        const clone = Effect.gen(function* () {
          const cloned = yield* on(
            git(
              dirname(dest),
              ["-c", "credential.interactive=false", "clone", "--quiet", "--", url, partial],
              { timeoutMs: CLONE_TIMEOUT_MS, env },
            ),
          ).pipe(Effect.mapError((error) => failed(error.message)));
          if (cloned.status !== 0)
            return yield* failed(`Couldn't clone ${url}: ${cloned.stderr.trim()}`);
          renameSync(partial, dest);
        });
        // A clone that failed, overran or was given up leaves no half-made folder behind.
        yield* clone.pipe(
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.sync(() => rmSync(partial, { recursive: true, force: true })),
          ),
        );
        return { path: realPathSync(dest) };
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(failed(defect instanceof Error ? defect.message : String(defect))),
        ),
      ),
    );
  };
  return { ensure };
};

export type HostRepos = ReturnType<typeof reposOn>;
