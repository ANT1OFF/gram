import { errnoCode } from "@gram/contracts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { fail, headOid, pinCommit, repoTopOrFail, run, tempIndex } from "./checkpoint-git.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg } from "./exec.ts";

/** What `undoTurnFiles` did, or why it did nothing. Every refusal leaves the working tree as it was. */
export type TurnUndo =
  | { readonly kind: "undone"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "nothing" }
  | { readonly kind: "committed"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "history" }
  | { readonly kind: "changed"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "obstructed"; readonly paths: ReadonlyArray<string> }
  | {
      readonly kind: "unsupported";
      readonly reason: "symlink" | "submodule" | "mode" | "filter";
      readonly paths: ReadonlyArray<string>;
    }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly paths: ReadonlyArray<string>;
    };

interface Entry {
  readonly mode: string;
  readonly oid: string;
}

interface Change {
  readonly path: string;
  readonly start?: Entry;
  readonly end?: Entry;
}

const LIST_MAX = 20;

const entry = (mode: string, oid: string): Entry | undefined =>
  /^0+$/.test(mode) ? undefined : { mode, oid };

const parseRaw = (stdout: string): ReadonlyArray<Change> => {
  const fields = stdout.split("\0");
  const changes: Array<Change> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    const path = fields[i + 1]!;
    if (!meta.startsWith(":") || path === "") continue;
    const [oldMode = "", newMode = "", oldOid = "", newOid = ""] = meta.slice(1).split(" ");
    const start = entry(oldMode, oldOid);
    const end = entry(newMode, newOid);
    changes.push({
      path,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    });
  }
  return changes.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

const whole = (out: { readonly stdout: string; readonly truncated: boolean }, what: string) =>
  out.truncated ? fail(`${what} is too long to check`) : Effect.succeed(out.stdout);

const splitZ = (stdout: string) => stdout.split("\0").filter((path) => path !== "");

const committedPaths = (top: string, base: string | undefined, head: string | undefined) =>
  Effect.gen(function* () {
    if (head === undefined) return base === undefined ? new Set<string>() : ("history" as const);
    if (head === base) return new Set<string>();
    if (base !== undefined) {
      const ancestor = yield* git(top, ["merge-base", "--is-ancestor", base, head]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      if (ancestor.status === 1) return "history" as const;
      if (ancestor.status !== 0) return yield* fail(gitFailMsg(ancestor, "git merge-base failed"));
    }
    const out = yield* run(top, [
      "-c",
      "log.showSignature=false",
      "log",
      "-m",
      "--no-renames",
      "--name-only",
      "--format=",
      "-z",
      base === undefined ? head : `${base}..${head}`,
      "--",
    ]);
    return new Set(splitZ(yield* whole(out, "the commit history since the turn")));
  });

type FsKind = "absent" | "dir" | "file" | "symlink" | "other";

const kindOf = (abs: string): { readonly kind: FsKind; readonly stat?: fs.Stats } => {
  try {
    const stat = fs.lstatSync(abs);
    const kind: FsKind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "dir"
        : stat.isFile()
          ? "file"
          : "other";
    return { kind, stat };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw error;
  }
};

const ancestorsOf = (rel: string): ReadonlyArray<string> => {
  const parts = rel.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

const blobOid = (bytes: Buffer, oidLength: number) =>
  createHash(oidLength === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

const convertedPaths = (top: string, rels: ReadonlyArray<string>, trees: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const found = new Set<string>();
    for (const source of [undefined, ...trees]) {
      const out = yield* run(
        top,
        [
          "check-attr",
          "-z",
          "--stdin",
          ...(source === undefined ? [] : [`--source=${source}`]),
          "filter",
          "working-tree-encoding",
        ],
        {},
        rels.join("\0"),
      );
      const fields = (yield* whole(out, "the turn's file attributes")).split("\0");
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const value = fields[i + 2];
        if (value !== "unspecified" && value !== "unset") found.add(fields[i]!);
      }
    }
    return [...found].toSorted();
  });

const sync = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (e) => new CheckpointError({ message: String(e) }) });

const fileModeHonoured = (top: string) =>
  git(top, ["config", "--bool", "core.fileMode"]).pipe(
    Effect.map((out) => out.stdout.trim() !== "false"),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );

const tempFolder = Effect.acquireRelease(
  Effect.sync(() => fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-undo-"))),
  (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
);

/** For tests: runs between the checks and `git apply`, as an editor saving then would. */
export interface UndoHooks {
  readonly beforeApply?: () => void;
  /** Runs between `git apply --check` and the apply itself. */
  readonly afterCheck?: () => void;
}

/**
 * Reverse one turn's file edits: its patch (`start` checkpoint against `end`) applied backwards to
 * the working tree with `git apply -R`, never the index. Before that every path the turn touched must
 * hold, byte for byte, what the turn left there (its end blob, or that blob as git writes it out),
 * where it deleted something nothing may stand (ignored files included), every folder above must be a
 * plain writable folder, and no commit since the turn started may touch any of them. Symlinks,
 * submodules and mode changes are refused. `git apply` checks the whole patch before it writes, so
 * the patch reverses whole or not at all.
 */
export const undoTurnFiles = (repo: string, start: string, end: string, hooks: UndoHooks = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const top = yield* repoTopOrFail(repo);
      const from = yield* pinCommit(top, start);
      const to = yield* pinCommit(top, end);
      const changes = parseRaw(
        yield* whole(
          yield* run(top, ["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to]),
          "the turn's changes",
        ),
      );
      if (changes.length === 0) return { kind: "nothing" } satisfies TurnUndo;
      const paths = changes.map((c) => c.path);

      const unsupported = (
        reason: "symlink" | "submodule" | "mode",
        test: (c: Change) => boolean,
      ) => {
        const hits = changes.filter(test).map((c) => c.path);
        return hits.length === 0
          ? undefined
          : ({ kind: "unsupported", reason, paths: hits } satisfies TurnUndo);
      };
      const refusedKind =
        unsupported("submodule", (c) => c.start?.mode === "160000" || c.end?.mode === "160000") ??
        unsupported("symlink", (c) => c.start?.mode === "120000" || c.end?.mode === "120000") ??
        unsupported(
          "mode",
          (c) => c.start !== undefined && c.end !== undefined && c.start.mode !== c.end.mode,
        );
      if (refusedKind !== undefined) return refusedKind;
      const converted = yield* convertedPaths(top, paths, [from, to]);
      if (converted.length > 0)
        return { kind: "unsupported", reason: "filter", paths: converted } satisfies TurnUndo;

      const base = (yield* git(top, ["rev-parse", "--verify", "--quiet", `${from}^1`]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      )).stdout.trim();
      const committed = yield* committedPaths(
        top,
        base === "" ? undefined : base,
        yield* headOid(top),
      );
      if (committed === "history") return { kind: "history" } satisfies TurnUndo;
      const hits = paths.filter((path) => committed.has(path));
      if (hits.length > 0) return { kind: "committed", paths: hits } satisfies TurnUndo;

      const scratch = yield* tempFolder;
      const writtenOut = (tree: string, side: "start" | "end") =>
        Effect.gen(function* () {
          const rels = changes.filter((c) => c[side] !== undefined).map((c) => c.path);
          const into = nodePath.join(scratch, side);
          if (rels.length === 0) return [] as ReadonlyArray<string>;
          const indexFile = yield* tempIndex;
          const env = { GIT_INDEX_FILE: indexFile };
          yield* run(top, ["read-tree", tree], env);
          yield* git(
            top,
            ["checkout-index", "-f", "-z", "--stdin", `--prefix=${into}${nodePath.sep}`],
            { env, tier: "slow", stdin: rels.join("\0") },
          ).pipe(
            Effect.mapError((e) => new CheckpointError({ message: e.message })),
            Effect.flatMap((out) =>
              out.status === 0
                ? Effect.void
                : fail(gitFailMsg(out, "git couldn't write out the turn's files")),
            ),
          );
          return yield* sync(() =>
            changes.flatMap((c) => {
              const blob = c[side];
              if (blob === undefined) return [];
              const bytes = fs.readFileSync(nodePath.join(into, c.path));
              return blobOid(bytes, blob.oid.length) === blob.oid ? [] : [c.path];
            }),
          );
        });
      const differs = [
        ...new Set([...(yield* writtenOut(from, "start")), ...(yield* writtenOut(to, "end"))]),
      ].toSorted();
      if (differs.length > 0)
        return { kind: "unsupported", reason: "filter", paths: differs } satisfies TurnUndo;
      const execBits = yield* fileModeHonoured(top);

      const verdict = yield* sync(() => {
        const changed: Array<string> = [];
        const obstructed: Array<string> = [];
        for (const change of changes) {
          let nearest = top;
          let clear = true;
          for (const folder of ancestorsOf(change.path)) {
            const { kind } = kindOf(nodePath.join(top, folder));
            if (kind === "dir") {
              nearest = nodePath.join(top, folder);
              continue;
            }
            if (kind !== "absent") {
              obstructed.push(folder);
              clear = false;
            }
            break;
          }
          if (!clear) continue;
          try {
            fs.accessSync(nearest, fs.constants.W_OK);
          } catch {
            obstructed.push(nodePath.relative(top, nearest) || ".");
            continue;
          }
          const abs = nodePath.join(top, change.path);
          const { kind, stat } = kindOf(abs);
          if (change.end === undefined) {
            if (kind !== "absent") changed.push(change.path);
            continue;
          }
          if (kind !== "file") {
            changed.push(change.path);
            continue;
          }
          if (execBits && ((stat!.mode & 0o100) !== 0) !== (change.end.mode === "100755")) {
            changed.push(change.path);
            continue;
          }
          const bytes = fs.readFileSync(abs);
          if (blobOid(bytes, change.end.oid.length) !== change.end.oid) changed.push(change.path);
        }
        return { changed, obstructed: [...new Set(obstructed)] };
      });
      if (verdict.obstructed.length > 0)
        return {
          kind: "obstructed",
          paths: verdict.obstructed.slice(0, LIST_MAX),
        } satisfies TurnUndo;
      if (verdict.changed.length > 0)
        return { kind: "changed", paths: verdict.changed } satisfies TurnUndo;

      const patch = nodePath.join(scratch, "turn.patch");
      yield* run(top, [
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `--output=${patch}`,
        from,
        to,
      ]);
      hooks.beforeApply?.();
      const apply = ["apply", "-R", "--whitespace=nowarn"];
      const checked = yield* git(top, [...apply, "--check", patch]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      if (checked.status !== 0)
        return {
          kind: "refused",
          message: gitFailMsg(checked, "git apply refused the reversed patch"),
        } satisfies TurnUndo;
      hooks.afterCheck?.();
      const applied = yield* git(top, [...apply, patch]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
        Effect.uninterruptible,
      );
      if (applied.status !== 0)
        return {
          kind: "failed",
          message: gitFailMsg(applied, "git apply failed"),
          paths,
        } satisfies TurnUndo;
      return { kind: "undone", paths } satisfies TurnUndo;
    }),
  );
