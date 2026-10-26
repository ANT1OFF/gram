import { FS_FILES_LIMIT, InvalidState, type FsFilesResult } from "@gram/contracts";
import { git, ProcTimeout, repoTop, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const NAMES_TIMEOUT_MS = 10_000;
const NAMES_MAX_BYTES = 16 * 1024 * 1024;
/** Never listed, even when git doesn't ignore them. */
const SKIPPED = new Set([".git", "node_modules"]);

const skipped = (path: string) => path.split("/").some((segment) => SKIPPED.has(segment));

/** The files, capped at `limit`, with every folder above them, sorted by path. */
export const namesResult = (files: ReadonlyArray<string>, limit: number): FsFilesResult => {
  const listed = files.filter((path) => path !== "" && !skipped(path)).toSorted();
  const kept = listed.slice(0, limit);
  const dirs = new Set<string>();
  for (const path of kept) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      dirs.add(path.slice(0, slash));
    }
  }
  const entries = [
    ...[...dirs].map((path) => ({ path, kind: "dir" as const })),
    ...kept.map((path) => ({ path, kind: "file" as const })),
  ].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated: listed.length > limit };
};

/** Every file below `root` outside `.git` and `node_modules`, for a folder that isn't a repo. */
const walk = (root: string, limit: number) =>
  Effect.tryPromise({
    try: async () => {
      const files: string[] = [];
      const pending = [""];
      while (pending.length > 0 && files.length <= limit) {
        const dir = pending.shift()!;
        let children: Dirent[];
        try {
          children = await readdir(join(root, dir), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          if (SKIPPED.has(child.name)) continue;
          const path = dir === "" ? child.name : `${dir}/${child.name}`;
          if (child.isDirectory()) pending.push(path);
          else files.push(path);
        }
      }
      return files;
    },
    catch: () => new InvalidState({ message: "Couldn't list the files" }),
  });

/**
 * Every file in `root` for `@` mentions: in a repo, tracked files plus untracked ones git doesn't
 * ignore (`git ls-files`); elsewhere a walk of the folder.
 */
export const listFileNames = (
  root: string,
  limit: number = FS_FILES_LIMIT,
): Effect.Effect<FsFilesResult, InvalidState, Proc> =>
  Effect.gen(function* () {
    if ((yield* repoTop(root)) === undefined) return namesResult(yield* walk(root, limit), limit);
    const out = yield* git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      timeoutMs: NAMES_TIMEOUT_MS,
      maxOutputBytes: NAMES_MAX_BYTES,
    }).pipe(Effect.result);
    if (Result.isFailure(out)) {
      if (out.failure instanceof ProcTimeout) return { entries: [], truncated: true };
      return yield* new InvalidState({ message: "Couldn't run git to list the files" });
    }
    const { status, stdout, truncated } = out.success;
    if (status !== 0) return yield* new InvalidState({ message: "Couldn't list the files" });
    const records = stdout.split("\0");
    // Output cut at the byte cap loses its partial last record.
    if (truncated) records.pop();
    const result = namesResult(records, limit);
    return truncated ? { ...result, truncated: true } : result;
  });
