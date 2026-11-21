import { git, isInside, OriginRefused, type OriginGuard, tryRealPathSync } from "@gram/git";
import * as Effect from "effect/Effect";
import { basename, dirname, relative, sep } from "node:path";
import { effectiveOriginsReach } from "./origin-reach.ts";
import { cloneIdentityOf, repositoryOfIdentity } from "./repos.ts";

const refuse = (message: string) => Effect.fail(new OriginRefused({ message }));

const repositoryOfCloneFolder = (clones: string, top: string): string | undefined => {
  const parts = relative(clones, top).split(sep);
  if (parts.length !== 3) return undefined;
  parts[2] = parts[2]!.replace(/\+[0-9a-f]{16}$/, "");
  return parts.join(sep).toLowerCase();
};

/**
 * The origin guard of a joined or provisioned machine's host, whose clones are kept under
 * `clones`. A clone the host made for the control plane is named for the repository it was cloned
 * from (`<host>/<owner>/<name>+<hash>`, `reposOn`), so its stored origin must name that
 * repository and git must reach no other (`effectiveOriginsReach`), or nothing of the host's
 * reaches it. A folder of the person's own on the machine has nothing recorded to hold it to but
 * its own stored origin, and a rewrite past that is only logged, as reach there is the person's.
 */
export const hostOriginGuard =
  (clones: string): OriginGuard =>
  (dir) =>
    Effect.gen(function* () {
      const common = yield* git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        timeoutMs: 2_000,
      }).pipe(Effect.option);
      if (common._tag === "None" || common.value.status !== 0)
        return yield* refuse(
          "Gram couldn't read which repository this folder is on this machine, so nothing of Gram's reaches its origin.",
        );
      const top = dirname(common.value.stdout.trim());
      const root = tryRealPathSync(clones) ?? clones;
      const ours = isInside(root, top);
      const mismatch = ours ? refuse : (message: string) => Effect.logWarning(message);
      const stored = yield* git(dir, ["config", "--no-includes", "--get", "remote.origin.url"], {
        timeoutMs: 2_000,
      }).pipe(Effect.option);
      if (stored._tag === "None" || (stored.value.status !== 0 && stored.value.status !== 1))
        return yield* mismatch(
          "Gram couldn't read this folder's origin on this machine, so nothing of Gram's reaches it.",
        );
      const url = stored.value.status === 0 ? stored.value.stdout.trim() : "";
      const identity = url === "" ? undefined : cloneIdentityOf(url);
      if (ours) {
        const named = repositoryOfCloneFolder(root, top);
        if (
          named === undefined ||
          identity === undefined ||
          repositoryOfIdentity(identity) !== named
        )
          return yield* refuse(
            `${top}'s origin names another repository than the one this machine cloned it for, so nothing of Gram's reaches it. Set it back, or remove the clone and let Gram clone it again.`,
          );
      }
      const urls = yield* effectiveOriginsReach(
        { name: basename(top), originIdentity: identity },
        dir,
        mismatch,
      );
      return ours ? urls : undefined;
    });
