// The git plumbing checkpoints and turn undo share: runs that fail on a non-zero exit, refs read once
// and pinned to the commit they name, and a private index. Not exported from the package.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg, tryRepoTop } from "./exec.ts";

export const fail = (message: string) => Effect.fail(new CheckpointError({ message }));

/** git in `cwd`, failing on a non-zero exit. */
export const run = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) =>
  git(cwd, args, { env, tier: "slow" }).pipe(
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
    Effect.flatMap((out) =>
      out.status === 0 ? Effect.succeed(out) : fail(gitFailMsg(out, `git ${args[0] ?? ""} failed`)),
    ),
  );

export const repoTopOrFail = (repo: string) =>
  tryRepoTop(repo).pipe(
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
    Effect.flatMap((top) =>
      top === undefined ? fail(`${repo} is not a git repository`) : Effect.succeed(top),
    ),
  );

/** What one read of a ref found. */
type RefRead =
  | { readonly kind: "commit"; readonly oid: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * One read of `ref`: a full ref name (`refs/…`), whose type, commit and symbolic target one
 * exact-match `for-each-ref` reads together, or a full commit id. A symbolic ref, anything but a
 * commit, an abbreviated name and revision syntax (`^{tree}`, `~1`) are refused: Gram only ever
 * names checkpoints in full, and following a symbolic one would read the branch it points at.
 */
export const readRef = (top: string, ref: string) =>
  Effect.gen(function* () {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) {
      const type = yield* git(top, ["cat-file", "-t", ref]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      return type.status === 0 && type.stdout.trim() === "commit"
        ? ({ kind: "commit", oid: ref } satisfies RefRead)
        : ({ kind: "refused", message: `${ref} is not a commit` } satisfies RefRead);
    }
    if (!ref.startsWith("refs/") || /[\s^~:?*[\\]|@\{|\.\./.test(ref))
      return {
        kind: "refused",
        message: `${ref} is not a full checkpoint ref name`,
      } satisfies RefRead;
    const out = yield* run(top, [
      "for-each-ref",
      "--format=%(objecttype) %(objectname) %(symref) %(refname)",
      ref,
    ]);
    const entry = out.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .find((parts) => parts.length === 4 && parts[3] === ref);
    if (entry === undefined) return { kind: "missing" } satisfies RefRead;
    const [type, oid, symref] = entry;
    if (symref)
      return {
        kind: "refused",
        message: `${ref} is a symbolic ref, not a checkpoint`,
      } satisfies RefRead;
    if (type !== "commit")
      return {
        kind: "refused",
        message: `${ref} holds a ${type}, not a checkpoint commit`,
      } satisfies RefRead;
    return { kind: "commit", oid: oid! } satisfies RefRead;
  });

/**
 * The commit `ref` names, read once and pinned: the caller then works on that commit only and never
 * resolves the name again, so a ref swapped to a symbolic one meanwhile can't redirect it. A
 * symbolic ref, anything but a commit, abbreviated names and revision syntax are refused.
 */
export const pinCommit = (top: string, ref: string) =>
  Effect.gen(function* () {
    const read = yield* readRef(top, ref);
    if (read.kind === "commit") return read.oid;
    if (read.kind === "refused") return yield* fail(read.message);
    return yield* fail(`no checkpoint ${ref}`);
  });

/** A scoped temp dir holding the private index. */
export const tempIndex = Effect.acquireRelease(
  Effect.sync(() =>
    nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-checkpoint-")), "index"),
  ),
  (indexFile) =>
    Effect.sync(() => fs.rmSync(nodePath.dirname(indexFile), { recursive: true, force: true })),
);

/** HEAD's commit, or undefined on an unborn branch. */
export const headOid = (top: string) =>
  git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout.trim() : undefined)),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );
