import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  git,
  Proc,
  type ProcShape,
  realPathSync,
  remoteGit,
  tryRealPathSync,
  WorktreeError,
} from "@gram/git";
import type { HostRepoIdentity } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { redactUrlCredentials } from "./remote-url.ts";
import { withCloneLock } from "./clone-lock.ts";

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

const remoteOf = (
  url: string,
):
  | { readonly folder: string; readonly legacyFolder: string; readonly identity: string }
  | { readonly error: string } => {
  const refuse = { error: "That remote isn't an https or ssh URL the host clones." };
  if (url.length > 512 || url.startsWith("-") || /[\s\0\\]/.test(url)) return refuse;
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
    transport = "scp";
    port = "22";
  } else return refuse;
  const segments = [host.toLowerCase(), ...path.replace(/\.git\/?$/, "").split("/")].filter(
    (segment) => segment !== "",
  );
  if (
    segments.length < 3 ||
    segments.length > 6 ||
    !segments.every((segment) => SEGMENT.test(segment) && !segment.startsWith("."))
  )
    return refuse;
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
 * The repository a clone identity names, as `host/owner/name` in lower case, whatever transport,
 * port or account reaches it: https and ssh to one repository name the same. `undefined` for
 * anything that isn't one.
 */
export const repositoryOfIdentity = (identity: string): string | undefined => {
  const url = cloneUrlOf(identity);
  const remote = url === undefined ? undefined : remoteOf(url);
  return remote === undefined || "error" in remote ? undefined : remote.legacyFolder.toLowerCase();
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

/**
 * The identity (`cloneIdentityOf`'s) of the `origin` of the repository at `dir` on this machine,
 * as stored, not as `insteadOf` rewrites it: what a checkout records as Gram makes it, so that a
 * later check of the worker's ownership never goes by the origin the worker can rewrite since.
 * `undefined` when it can't be read or isn't a remote the host clones.
 */
export const originIdentityAt = (dir: string) =>
  git(dir, ["config", "--get", "remote.origin.url"], { timeoutMs: 2_000 }).pipe(
    Effect.map((out) =>
      out.status === 0 && out.stdout.trim() !== "" ? cloneIdentityOf(out.stdout.trim()) : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );

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
            const origin = yield* on(
              git(dest, ["config", "--local", "--no-includes", "--get", "remote.origin.url"]),
            ).pipe(Effect.mapError((error) => failed(error.message)));
            const kept = origin.status === 0 ? remoteOf(origin.stdout.trim()) : undefined;
            if (kept === undefined || !("folder" in kept) || kept.identity !== target.identity) {
              if (legacy) return yield* ensureIn(target.folder, false);
              return yield* new WorktreeError({
                reason: "conflict",
                message: `${dest} already holds a different origin. Move that clone or choose a different repository; nothing was fetched.`,
                dirty: false,
              });
            }
            yield* on(
              remoteGit(
                dest,
                [
                  "-c",
                  "credential.interactive=false",
                  "fetch",
                  "--quiet",
                  "--prune",
                  "--end-of-options",
                  "origin",
                ],
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
              remoteGit(
                dirname(dest),
                [
                  "-c",
                  "credential.interactive=false",
                  "clone",
                  "--quiet",
                  "--end-of-options",
                  url,
                  partial,
                ],
                { timeoutMs: CLONE_TIMEOUT_MS, env },
              ),
            ).pipe(Effect.mapError((error) => failed(error.message)));
            if (cloned.status !== 0)
              return yield* failed(`Couldn't clone ${url}: ${cloned.stderr.trim()}`);
            if (!(yield* contained)) return yield* outside;
            renameSync(partial, dest);
          });
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
        yield* read(repoRoot, ["config", "--local", "--no-includes", ...origin]),
        yield* read(path, ["config", ...origin]),
        yield* read(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      ];
      const shared = mine === undefined ? undefined : tryRealPathSync(mine);
      const ofClone =
        shared !== undefined && clones !== undefined && shared === tryRealPathSync(clones);
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
