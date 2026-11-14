import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { git, Proc, type ProcShape, realPathSync, tryRealPathSync, WorktreeError } from "@gram/git";
import type { HostRepoIdentity } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { redactUrlCredentials } from "./remote-url.ts";
import { withCloneLock } from "./clone-lock.ts";

/** How long a clone may take before it is given up. */
const CLONE_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 2 * 60_000;

/**
 * Only the transports a repository's remote is reached over: never `file`, `ext` or the
 * unauthenticated `git` daemon, whatever a URL asks for.
 */
export const HOST_REPO_GIT_ENV = {
  GIT_ALLOW_PROTOCOL: "https:ssh",
  GIT_TERMINAL_PROMPT: "0",
};

const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

/** Safe folder naming is deliberately lossy; only `identity` authorizes reuse of an origin. */
const remoteOf = (
  url: string,
):
  | { readonly folder: string; readonly legacyFolder: string; readonly identity: string }
  | { readonly error: string } => {
  const refuse = { error: "That remote isn't an https or ssh URL the host clones." };
  if (url.length > 512 || url.startsWith("-") || /[\s\0\\]/.test(url)) return refuse;
  // Never a path that climbs or names itself, which a URL parser would quietly resolve.
  if (/(^|[/:])\.\.?(\/|$)/.test(url)) return refuse;
  let host: string;
  let path: string;
  let identityPath: string;
  let transport: string;
  let user = "";
  let port = "";
  const scp = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url);
  if (url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refuse;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return refuse;
    if (parsed.password !== "" || (parsed.protocol === "https:" && parsed.username !== ""))
      return {
        error: "A remote with credentials in its URL isn't cloned; use a credential helper.",
      };
    if (parsed.protocol === "ssh:" && parsed.username !== "" && !SSH_USER.test(parsed.username))
      return refuse;
    if (parsed.search !== "" || parsed.hash !== "") return refuse;
    identityPath = parsed.pathname;
    transport = parsed.protocol;
    user = parsed.username;
    port = parsed.port || (parsed.protocol === "ssh:" ? "22" : "443");
    host = parsed.hostname;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return refuse;
    }
  } else if (scp !== null) {
    user = scp[1] ?? "";
    if (user !== "" && !SSH_USER.test(user)) return refuse;
    host = scp[2]!;
    path = scp[3]!;
    identityPath = path;
    // SCP paths can be relative to an account's home; SSH URL paths are absolute.
    transport = "scp";
    port = "22";
  } else return refuse;
  const segments = [host.toLowerCase(), ...path.replace(/\.git\/?$/, "").split("/")].filter(
    (segment) => segment !== "",
  );
  // No segment that is hidden or names a folder, such as `.git`, inside a clone.
  if (
    segments.length < 3 ||
    segments.length > 6 ||
    !segments.every((segment) => SEGMENT.test(segment) && !segment.startsWith("."))
  )
    return refuse;
  // Always three levels deep, a group's subgroups joined into the name, so no clone's folder is
  // ever inside another's: `gitlab.com/group/sub/repo` is `gitlab.com/group/sub+repo`.
  const [first, owner, ...name] = segments;
  const identity = JSON.stringify([transport, host.toLowerCase(), port, user, identityPath]);
  const legacyFolder = join(first!, owner!, name.join("+"));
  return {
    legacyFolder,
    folder: `${legacyFolder}+${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
    identity,
  };
};

/** The readable clone folder, never a proof that two remotes name the same repository. */
export const cloneFolderOf = (
  url: string,
): { readonly folder: string } | { readonly error: string } => {
  const remote = remoteOf(url);
  return "error" in remote ? remote : { folder: remote.folder };
};

/**
 * The identity of the repository `url` names (transport, host, port, SSH account and path), as
 * clones are told apart by; `undefined` for a URL the host doesn't clone. Names no secret: a URL
 * with a password, or an https one with a user, has none.
 */
export const cloneIdentityOf = (url: string): string | undefined => {
  const remote = remoteOf(url);
  return "error" in remote ? undefined : remote.identity;
};

/**
 * A URL for the repository `identity` names (`cloneIdentityOf`'s), which a clone made from it is
 * told apart by the same identity; `undefined` for anything that isn't one, or doesn't read back
 * as itself. Names no secret, as the identity names none.
 */
export const cloneUrlOf = (identity: string): string | undefined => {
  let parts: unknown;
  try {
    parts = JSON.parse(identity);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length !== 5 || !parts.every((p) => typeof p === "string"))
    return undefined;
  const [transport, host, port, user, path] = parts as Array<string>;
  const account = user === "" ? "" : `${user}@`;
  const url =
    transport === "https:"
      ? `https://${host}${port === "443" ? "" : `:${port}`}${path}`
      : transport === "ssh:"
        ? `ssh://${account}${host}${port === "22" ? "" : `:${port}`}${path}`
        : transport === "scp"
          ? `${account}${host}:${path}`
          : undefined;
  return url !== undefined && cloneIdentityOf(url) === identity ? url : undefined;
};

/** `cloneIdentityOf`, of a URL that may not be there. */
const identityOf = (url: string | undefined) =>
  url === undefined ? undefined : cloneIdentityOf(url);

const failed = (message: string) =>
  new WorktreeError({
    reason: "failed",
    message: redactUrlCredentials(message).slice(0, 400),
    dirty: false,
  });

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
  const env = { ...HOST_REPO_GIT_ENV, ...extraEnv };
  const ensure = (url: string): Effect.Effect<{ readonly path: string }, WorktreeError> => {
    const target = remoteOf(url);
    if ("error" in target)
      return Effect.fail(
        new WorktreeError({ reason: "invalidRequest", message: target.error, dirty: false }),
      );
    const ensureIn = (
      folder: string,
      legacy: boolean,
    ): Effect.Effect<{ readonly path: string }, WorktreeError> => {
      const dest = join(root, folder);
      /**
       * Every folder from `root` down to the clone is a real folder of its own, never a link, so a
       * clone can't be made, or answered, anywhere outside `root`.
       */
      const contained = Effect.sync(() => {
        let at = root;
        for (const part of folder.split(sep)) {
          at = join(at, part);
          const stat = lstatSync(at, { throwIfNoEntry: false });
          if (stat === undefined) return true;
          if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
        }
        return true;
      });
      const outside = new WorktreeError({
        reason: "conflict",
        message: `${dest} isn't a folder of its own under ${root}, so nothing is cloned there.`,
        dirty: false,
      });
      return withCloneLock(
        dest,
        Effect.gen(function* () {
          if (!(yield* contained)) return yield* outside;
          if (existsSync(dest)) {
            const origin = yield* on(git(dest, ["remote", "get-url", "origin"])).pipe(
              Effect.mapError((error) => failed(error.message)),
            );
            const kept = origin.status === 0 ? remoteOf(origin.stdout.trim()) : undefined;
            if (kept === undefined || !("folder" in kept) || kept.identity !== target.identity) {
              // Older hosts used the readable name alone. Leave another identity there untouched,
              // and give this identity its own stable folder. Hash-folder collisions still refuse.
              if (legacy) return yield* ensureIn(target.folder, false);
              return yield* new WorktreeError({
                reason: "conflict",
                message: `${dest} already holds a different origin. Move that clone or choose a different repository; nothing was fetched.`,
                dirty: false,
              });
            }
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
          if (legacy) return yield* ensureIn(target.folder, false);
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
            if (!(yield* contained)) return yield* outside;
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
    return ensureIn(target.legacyFolder, true);
  };
  /**
   * What the worktree at `path` is now, beside the clone at `repoRoot`: its origin's identity,
   * whether it shares that clone's repository, and its branch. Read-only, and anything git can't
   * say is left out, so the control plane fails closed on it.
   */
  const read = (cwd: string, args: ReadonlyArray<string>) =>
    on(git(cwd, args, { timeoutMs: 5_000 })).pipe(
      Effect.map((out) => (out.status === 0 ? out.stdout.trim() || undefined : undefined)),
      Effect.orElseSucceed(() => undefined),
    );
  const identify = (repoRoot: string, path: string): Effect.Effect<HostRepoIdentity> =>
    Effect.gen(function* () {
      const common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
      const origin = ["--get", "remote.origin.url"];
      const [mine, clones, stored, effective, branch] = [
        yield* read(path, common),
        yield* read(repoRoot, common),
        // As stored, not as `insteadOf` rewrites it: the URL the clone was made from, in the
        // clone's own config, which no worktree-scoped or included setting stands in for.
        yield* read(repoRoot, ["config", "--local", "--no-includes", ...origin]),
        // And where the worktree's own pushes go, which a worktree-scoped setting can change.
        yield* read(path, ["config", ...origin]),
        yield* read(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      ];
      const shared = mine === undefined ? undefined : tryRealPathSync(mine);
      const ofClone =
        shared !== undefined && clones !== undefined && shared === tryRealPathSync(clones);
      // An identity only when both say the same one: otherwise none, and nothing is confirmed.
      const identity = identityOf(stored);
      const agreed = identity !== undefined && identityOf(effective) === identity;
      return {
        ofClone,
        ...(agreed ? { identity } : {}),
        ...(branch === undefined ? {} : { branch }),
      };
    });
  return { ensure, identify };
};

export type HostRepos = ReturnType<typeof reposOn>;
