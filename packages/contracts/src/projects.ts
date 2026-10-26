import * as Schema from "effect/Schema";
import { ProjectId } from "./ids.ts";

/** `projects.setBookmarked`: adds a project to the `/new` Bookmarks section, or removes it. */
export const SetProjectBookmarkedPayload = Schema.Struct({
  projectId: ProjectId,
  bookmarked: Schema.Boolean,
});
export type SetProjectBookmarkedPayload = typeof SetProjectBookmarkedPayload.Type;

/** `projects.forget`: removes a project from the `/new` recents while no thread belongs to it. */
export const ForgetProjectPayload = Schema.Struct({ projectId: ProjectId });
export type ForgetProjectPayload = typeof ForgetProjectPayload.Type;

/**
 * `projects.add`: the project whose root is this folder, registered if Gram doesn't know it
 * yet. Only the top folder of a git repository's main checkout qualifies.
 */
export const AddProjectPayload = Schema.Struct({ root: Schema.NonEmptyString });
export type AddProjectPayload = typeof AddProjectPayload.Type;

/** A repository a new workspace can work in: a known project, or one found and not added yet. */
export const RepositoryCandidate = Schema.Struct({
  name: Schema.String,
  root: Schema.String,
  /** The project it is; absent for a repository found in a folder, which `projects.add` adds. */
  projectId: Schema.optionalKey(ProjectId),
});
export type RepositoryCandidate = typeof RepositoryCandidate.Type;

/**
 * `projects.repositories`: the known projects that are repositories, then every other repository
 * directly in the default folder and the clone folder, each once.
 */
export const RepositoryCandidates = Schema.Struct({ repos: Schema.Array(RepositoryCandidate) });
export type RepositoryCandidates = typeof RepositoryCandidates.Type;

/** Why a linked worktree or a submodule can't be added: its repository's own folder can. */
export const linkedCheckoutMessage = (path: string): string =>
  `${path} is a linked worktree or a submodule. Choose the repository's own folder.`;

/** Why a folder that isn't a repository's top folder can't be added, in the user's terms. */
export const notARepositoryMessage = (path: string): string =>
  `${path} isn't the top folder of a git repository. Workers each work in a git worktree, so only a repository can be added: choose its top folder, or run git init in it first.`;

/**
 * `projects.clone`: a GitHub `owner/repo`, or a repository's https or ssh URL, cloned into
 * `<into>/<repo>` and registered as a project. Checked with `parseRepoRemote`.
 */
export const CloneProjectPayload = Schema.Struct({
  remote: Schema.NonEmptyString,
  /** An absolute folder to clone into, instead of the "Where new clones go" setting. */
  into: Schema.optionalKey(Schema.NonEmptyString),
});
export type CloneProjectPayload = typeof CloneProjectPayload.Type;

/** `projects.cloneSuggestions`: `owner/repo` names worth offering, most recently pushed first. */
export const CloneSuggestions = Schema.Struct({ repos: Schema.Array(Schema.String) });
export type CloneSuggestions = typeof CloneSuggestions.Type;

/** A repository to clone: GitHub's own, cloned with `gh`, or any other git URL, cloned with `git`. */
export type RepoRemote =
  | { readonly kind: "github"; readonly owner: string; readonly repo: string }
  | {
      readonly kind: "url";
      readonly url: string;
      /** With the URL's port, if it names one: another port can be another server. */
      readonly host: string;
      /** The URL's path, without a trailing `.git`. */
      readonly path: string;
      readonly repo: string;
    };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
const USER = /^[A-Za-z0-9._-]+$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

const withoutGit = (name: string) =>
  name.toLowerCase().endsWith(".git") ? name.slice(0, -4) : name;
const isName = (name: string) => NAME.test(name) && name !== "." && name !== "..";

/** A URL's path as its segments; `undefined` for `..` or an empty segment. */
const segmentsOf = (path: string): string[] | undefined => {
  const segments = path.replace(/\/$/, "").split("/");
  return segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
    ? segments
    : undefined;
};

/** The remote at `host`/`segments`, spelled back as `url` builds it; GitHub's over https is `gh`'s. */
const remoteAt = (
  host: string,
  segments: readonly string[] | undefined,
  url: (path: string) => string,
  https = false,
): RepoRemote | undefined => {
  if (segments === undefined || !HOST.test(host)) return undefined;
  const repo = withoutGit(segments.at(-1)!);
  if (!isName(repo)) return undefined;
  const owner = segments[0]!;
  if (https && GITHUB_HOSTS.has(host.toLowerCase())) {
    return segments.length === 2 && OWNER.test(owner) ? { kind: "github", owner, repo } : undefined;
  }
  const path = [...segments.slice(0, -1), repo].join("/");
  return { kind: "url", url: url(segments.join("/")), host: host.toLowerCase(), path, repo };
};

/**
 * `input` as a repository to clone, or why it isn't one: `EXAMPLE/repo`, `github.com/EXAMPLE/repo`, an
 * https URL, `ssh://…` or `git@host:owner/repo`. Strict on purpose, since the result becomes a
 * command's argument and a folder's name: no whitespace, no leading `-`, no `..`, no credentials.
 */
export const parseRepoRemote = (input: string): RepoRemote | { readonly error: string } => {
  const text = input.trim();
  if (text === "") return { error: "Type a GitHub repository, such as owner/repo, or its URL." };
  const invalid = { error: `${text} isn't a GitHub repository or a git URL.` };
  // Printable ASCII only, which also keeps out whitespace; `?`, `#` and `\\` have no place in one.
  if (/[^\x21-\x7e]|[\\?#]/.test(text) || text.startsWith("-")) return invalid;
  if (text.startsWith("http://")) return { error: "Use the repository's https URL." };

  const https =
    /^https:\/\/([^/]*)\/(.+)$/.exec(text) ?? /^((?:www\.)?github\.com)\/(.+)$/i.exec(text);
  if (https !== null) {
    const host = https[1]!;
    if (host.includes("@")) {
      return { error: "Paste the repository's URL without a user name or token in it." };
    }
    const lower = host.toLowerCase();
    return remoteAt(lower, segmentsOf(https[2]!), (p) => `https://${lower}/${p}`, true) ?? invalid;
  }

  const ssh = /^ssh:\/\/(?:([^@/]+)@)?([^/]+)\/(.+)$/.exec(text);
  if (ssh !== null) {
    const user = ssh[1];
    const host = ssh[2]!;
    if (user !== undefined && !USER.test(user)) return invalid;
    const prefix = `ssh://${user === undefined ? "" : `${user}@`}${host}`;
    return remoteAt(host, segmentsOf(ssh[3]!), (p) => `${prefix}/${p}`) ?? invalid;
  }

  const scp = /^([^@/:]+)@([^/:]+):(.+)$/.exec(text);
  if (scp !== null) {
    const user = scp[1]!;
    const host = scp[2]!;
    if (!USER.test(user)) return invalid;
    return remoteAt(host, segmentsOf(scp[3]!), (p) => `${user}@${host}:${p}`) ?? invalid;
  }

  const short = /^([^/]+)\/([^/]+?)\/?$/.exec(text);
  const owner = short?.[1];
  const repo = short?.[2] === undefined ? undefined : withoutGit(short[2]);
  if (owner !== undefined && repo !== undefined && OWNER.test(owner) && isName(repo)) {
    return { kind: "github", owner, repo };
  }
  return invalid;
};

/** Which repository a remote names, the same for its https, ssh and `owner/repo` spellings. */
export const remoteKey = (remote: RepoRemote): string =>
  remote.kind === "github"
    ? `github.com/${remote.owner}/${remote.repo}`.toLowerCase()
    : // GitHub's names don't depend on case; another server's may, so only its host is folded.
      GITHUB_HOSTS.has(remote.host)
      ? `github.com/${remote.path}`.toLowerCase()
      : `${remote.host}/${remote.path}`;

/** How a remote is named to the user: `owner/repo` for GitHub's, else the URL. */
export const remoteLabel = (remote: RepoRemote): string =>
  remote.kind === "github" ? `${remote.owner}/${remote.repo}` : remote.url;

/** Whether typed text is a folder's path rather than a repository to clone. */
export const looksLikeFolderPath = (input: string): boolean =>
  /^(?:[~/\\.]|[A-Za-z]:[\\/])/.test(input.trim());
