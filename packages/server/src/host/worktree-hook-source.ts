import { createHash, randomUUID } from "node:crypto";
import { hidesText, type Checkout, type WorktreeHookKind } from "@gram/contracts";
import { git, realPath, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import { isolatedGitOptions } from "../git/isolated-git.ts";

export const WORKTREE_HOOK_VERSION = 1;
const MAX_SCRIPT_BYTES = 64 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ENTRY = /^([0-7]+) (tree|blob|commit) ([0-9a-f]+)\t(.+)$/;

export interface WorktreeHookSource {
  readonly kind: WorktreeHookKind;
  readonly path: string;
  readonly revision: string;
  readonly tree: string;
  readonly fingerprint: string;
  readonly script: string;
  readonly interpreter: string;
}

export type WorktreeHookLookup =
  | { readonly status: "found"; readonly source: WorktreeHookSource }
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly reason: string };

const invalid = (reason: string): WorktreeHookLookup => ({ status: "invalid", reason });

export const worktreeHookFingerprint = (path: string, script: string): string =>
  createHash("sha256")
    .update(JSON.stringify([WORKTREE_HOOK_VERSION, path, "100755", script]))
    .digest("hex");

export const markNewWorktree = (path: string) =>
  git(path, ["rev-parse", "--verify", "HEAD^{commit}"], isolatedGitOptions()).pipe(
    Effect.map((out) => {
      const revision = out.stdout.trim();
      return out.status === 0 && !out.truncated && OID.test(revision) ? revision : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
    Effect.map((revision): NonNullable<Checkout["worktreeSetup"]> => ({
      generation: randomUUID(),
      ...(revision === undefined ? {} : { revision }),
    })),
  );

/** A checkout's actual Git objects, with ref overrides, replace objects and lazy fetching off. */
export const resolveWorktreeHook = (
  checkout: string,
  kind: WorktreeHookKind,
  expectedRevision?: string,
  sourceAllowed?: (entry: { path: string; mode: string; oid: string }) => boolean,
): Effect.Effect<WorktreeHookLookup, never, Proc> =>
  Effect.gen(function* () {
    const options = {
      ...isolatedGitOptions({ GIT_NO_LAZY_FETCH: "1" }),
      maxOutputBytes: MAX_SCRIPT_BYTES + 1,
    };
    const gitText = (args: ReadonlyArray<string>) =>
      git(checkout, args, options).pipe(
        Effect.map((out) => (out.status === 0 && !out.truncated ? out.stdout : undefined)),
        Effect.orElseSucceed(() => undefined),
      );
    const top = yield* gitText(["rev-parse", "--show-toplevel"]);
    const atRoot = yield* Effect.tryPromise(async () =>
      top === undefined ? false : (await realPath(checkout)) === (await realPath(top.trimEnd())),
    ).pipe(Effect.orElseSucceed(() => false));
    if (!atRoot) return invalid("The worktree root is unavailable.");

    const revision = (yield* gitText(["rev-parse", "--verify", "HEAD^{commit}"]))?.trim();
    if (revision === undefined || !OID.test(revision))
      return invalid("The worktree has no readable committed revision.");
    if (expectedRevision !== undefined && expectedRevision !== revision)
      return invalid("The worktree revision changed before the hook could run.");
    const tree = (yield* gitText(["rev-parse", "--verify", `${revision}^{tree}`]))?.trim();
    if (tree === undefined || !OID.test(tree)) return invalid("The committed tree is unavailable.");

    const listed = yield* gitText(["ls-tree", "-z", tree, "--", ".gram", ".agents"]);
    if (listed === undefined) return invalid("The committed hook directories are unavailable.");
    const entries = listed.split("\0").map((row) => ENTRY.exec(row));
    for (const folder of [".gram", ".agents"]) {
      const entry = entries.find((row) => row?.[4] === folder);
      if (entry === undefined || entry === null) continue;
      if (entry[2] !== "tree" || entry[3] === undefined || !OID.test(entry[3]))
        return invalid(`${folder} is not a committed directory.`);

      const path = `${folder}/${kind}`;
      const file = yield* gitText(["ls-tree", "-z", entry[3], "--", kind]);
      if (file === undefined) return invalid(`Could not read ${path} from the committed tree.`);
      if (file === "") continue;
      const blob = ENTRY.exec(file.slice(0, -1));
      const oid = blob?.[3];
      if (blob?.[1] !== "100755" || blob[2] !== "blob" || oid === undefined || !OID.test(oid))
        return invalid(`${path} must be a committed executable file.`);
      if (sourceAllowed?.({ path, mode: blob[1], oid }) === false)
        return invalid(`${path} is outside the selected check source.`);
      const script = yield* gitText(["cat-file", "blob", oid]);
      if (script === undefined || Buffer.byteLength(script) > MAX_SCRIPT_BYTES)
        return invalid(`${path} is unreadable or exceeds 64 KiB.`);
      const actual = createHash(oid.length === 40 ? "sha1" : "sha256")
        .update(`blob ${Buffer.byteLength(script)}\0`)
        .update(script)
        .digest("hex");
      if (actual !== oid || script.includes("\0")) return invalid(`${path} must be UTF-8 text.`);
      if (hidesText(script))
        return invalid(`${path} contains characters Gram cannot show faithfully for approval.`);
      const shebang = script.split("\n", 1)[0] ?? "";
      const interpreter = /^#![ \t]*(\/[^\s]+)/.exec(shebang)?.[1];
      if (interpreter === undefined)
        return invalid(`${path} needs a shebang with an absolute interpreter path.`);
      const fingerprint = worktreeHookFingerprint(path, script);
      return {
        status: "found",
        source: { kind, path, revision, tree, fingerprint, script, interpreter },
      };
    }
    return { status: "absent" };
  });
