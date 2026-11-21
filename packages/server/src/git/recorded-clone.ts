// The clone identity a new checkout of a project records (`Checkout.cloneIdentity`), checked against
// the origin the project recorded when it was added (`Project.originIdentity`), since the folder's
// git config is anyone's to rewrite who works there (`git remote set-url`).

import { devNull } from "node:os";
import { InvalidState, type Project } from "@gram/contracts";
import { git, type Proc, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { githubRelayed } from "../embedding/github-relay.ts";
import { cloneIdentityOf, repositoryOfIdentity } from "../host/repos.ts";

/** Whether two clone identities name one repository: its host, owner and name, by any transport. */
const sameRepo = (a: string, b: string) => {
  const repo = repositoryOfIdentity(a);
  return repo !== undefined && repo === repositoryOfIdentity(b);
};

/** The project at `repoRoot`: its own folder, or the repository it is a folder of. */
const projectAt = (projects: ReadonlyArray<Project>, repoRoot: string) =>
  projects.find(
    (each) =>
      samePath(each.root, repoRoot) ||
      (each.repoRoot !== undefined && samePath(each.repoRoot, repoRoot)),
  );

/**
 * `live`, an origin identity of a folder of `project`, as long as it names the repository the
 * project recorded when it was added. The same repository by any transport (https or ssh, another
 * account) is the project's own. Behind an embedding deployment's GitHub route, where the
 * repository decides what the thread may read and push with the deployment's access, one that
 * names another repository is refused. Elsewhere reach is the person's own, so the mismatch is only
 * logged. No project, or no origin now, keeps what it has.
 */
const checkedAgainst = (
  project: Project | undefined,
  live: string | undefined,
): Effect.Effect<string | undefined, InvalidState> => {
  const recorded = project?.originIdentity;
  if (project === undefined || live === undefined || recorded === live) return Effect.succeed(live);
  if (recorded !== undefined && sameRepo(recorded, live)) return Effect.succeed(live);
  const message =
    recorded === undefined
      ? `Gram has no origin recorded for ${project.name}, and its folder has one now. If its origin couldn't be read when it was added, Gram reads it again when the next thread starts in it or Gram starts; if it had none, remove the project and add it again.`
      : `${project.name}'s origin names another repository than the one it was added with. Set it back, or remove the project and add it again.`;
  if (!githubRelayed()) return Effect.logWarning(message).pipe(Effect.as(live));
  return Effect.fail(new InvalidState({ message }));
};

/**
 * The identity a new checkout of `repoRoot` records as its clone's (`Checkout.cloneIdentity`), its
 * stored origin being `live` now, checked against its project's recorded origin (`checkedAgainst`).
 */
export const recordedCloneIdentity = (
  projects: ReadonlyArray<Project>,
  repoRoot: string,
  live: string | undefined,
): Effect.Effect<string | undefined, InvalidState> =>
  checkedAgainst(projectAt(projects, repoRoot), live);

/** The user's own (global, system) config is theirs, and its rewrites are not an agent's to make. */
const REPOSITORY_CONFIG_ONLY = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

const EFFECTIVE_ORIGINS = [
  ["remote", "get-url", "--all", "origin"],
  ["remote", "get-url", "--push", "--all", "origin"],
] as const;

/**
 * Where git in `dir` fetches `origin` from and pushes it to, after the repository's own
 * `url.*.insteadOf`, `url.*.pushInsteadOf` and `remote.origin.pushurl` (the user's own config is
 * left out, as theirs to set), each checked against
 * `project`'s recorded origin as the stored one is (`checkedAgainst`): an agent that leaves the
 * stored URL alone but sends git elsewhere is refused too. A URL that isn't a remote the host
 * clones (a local path) names no GitHub repository, and passes.
 */
export const effectiveOriginsChecked = (
  project: Project | undefined,
  dir: string,
): Effect.Effect<void, InvalidState, Proc> =>
  Effect.gen(function* () {
    if (project === undefined) return;
    for (const args of EFFECTIVE_ORIGINS) {
      const out = yield* git(dir, [...args], {
        timeoutMs: 2_000,
        env: REPOSITORY_CONFIG_ONLY,
      }).pipe(Effect.option);
      if (Option.isNone(out) || out.value.status !== 0) continue;
      for (const line of out.value.stdout.split("\n")) {
        const url = line.trim();
        if (url !== "") yield* checkedAgainst(project, cloneIdentityOf(url));
      }
    }
  });

/** `effectiveOriginsChecked` for the project at `repoRoot`. */
export const effectiveOriginsAt = (
  projects: ReadonlyArray<Project>,
  repoRoot: string,
  dir: string = repoRoot,
) => effectiveOriginsChecked(projectAt(projects, repoRoot), dir);
