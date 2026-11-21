// The clone identity a new checkout of a project records (`Checkout.cloneIdentity`), checked against
// the origin the project recorded when it was added (`Project.originIdentity`), since the folder's
// git config is anyone's to rewrite who works there (`git remote set-url`).

import { InvalidState, type Project } from "@gram/contracts";
import { type OriginUrls, type Proc, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import { githubRelayed } from "../embedding/github-relay.ts";
import { effectiveOriginsReach, sameRepo } from "../host/origin-reach.ts";

const refused = (message: string): Effect.Effect<void, InvalidState> =>
  githubRelayed() ? Effect.fail(new InvalidState({ message })) : Effect.logWarning(message);

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
  return refused(message).pipe(Effect.as(live));
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

/**
 * Where git in `dir` fetches `origin` from and pushes it to, and where LFS sends origin's large
 * files, each checked against `project`'s recorded origin (`effectiveOriginsReach`): behind a
 * route a refusal, elsewhere only logged. No project has nothing to check against. Gives the URLs
 * checked, for git to be given in place of `origin`.
 */
export const effectiveOriginsChecked = (
  project: Project | undefined,
  dir: string,
): Effect.Effect<OriginUrls | undefined, InvalidState, Proc> =>
  project === undefined ? Effect.succeed(undefined) : effectiveOriginsReach(project, dir, refused);

/** `effectiveOriginsChecked` for the project at `repoRoot`. */
export const effectiveOriginsAt = (
  projects: ReadonlyArray<Project>,
  repoRoot: string,
  dir: string = repoRoot,
) => effectiveOriginsChecked(projectAt(projects, repoRoot), dir);
