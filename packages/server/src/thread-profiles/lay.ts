// Laying a profile's files in a folder, and keeping them out of a repository's commits. Used where
// the folder is: by the server for a thread of its own machine, by a machine's host for one placed
// there (`host/thread-places.ts`).
import { InvalidState, type ProfileFile } from "@gram/contracts";
import { git, Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const refuse = (message: string) => new InvalidState({ message });

/**
 * Writes `files` under `folder`, making it and what lies between, and says which it wrote. The
 * paths were checked (`profilePathProblem`). A new folder holds nothing to collide with; in a
 * repository's checkout (`keepExisting`) a file already there is left as it is, the repository's
 * own winning, and nothing is written through a link, so no file lands outside the folder.
 */
export const layProfileFiles = (
  folder: string,
  files: ReadonlyArray<ProfileFile>,
  options: { readonly keepExisting?: boolean } = {},
): Effect.Effect<ReadonlyArray<string>, InvalidState> =>
  Effect.gen(function* () {
    let at = "the thread's folder";
    const laid: Array<string> = [];
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(folder, { recursive: true });
        for (const file of files) {
          at = file.path;
          const names = file.path.split("/");
          let parent = folder;
          for (const name of names.slice(0, -1)) {
            parent = join(parent, name);
            const stat = await lstat(parent).catch(() => undefined);
            if (stat === undefined) await mkdir(parent);
            else if (!stat.isDirectory()) throw Object.assign(new Error("link"), { code: "ELINK" });
          }
          const path = join(parent, names.at(-1)!);
          if (options.keepExisting === true && (await lstat(path).catch(() => undefined))) continue;
          // `wx` never follows a link left at the name, nor replaces what is there.
          await writeFile(path, file.content, { encoding: "utf8", flag: "wx" });
          laid.push(file.path);
        }
      },
      // The file's own path and the error's code: never where the data folder is.
      catch: (cause) =>
        refuse(
          `The profile's files couldn't be written (${at}: ${
            (cause as { code?: unknown } | null)?.code ?? "failed"
          }).`,
        ),
    });
    return laid;
  });

/** The file a checkout's own excludes are kept in, inside its git folder. */
const PROFILE_EXCLUDE = "profile-exclude";

/**
 * Keeps the files a profile laid in a checkout out of its commits: each is named in an exclude
 * file of that checkout alone, which no clone or push carries. Without it an agent's `git add`
 * would put the supplier's skills into the repository's history. The repository's `info/exclude`
 * won't do: every worktree of a clone shares it, so a name laid for one thread would hide the same
 * path in every other, for good. This one is in the worktree's own git folder, named by its own
 * `core.excludesFile`, and goes when the worktree does. Best effort: a checkout that can't take
 * it, or already names an excludes file of its own, keeps the files visible.
 */
export const excludeLaid = (
  proc: ProcShape,
  checkout: string,
  laid: ReadonlyArray<string>,
): Effect.Effect<void> => {
  const run = (args: ReadonlyArray<string>) =>
    git(checkout, args).pipe(Effect.provideService(Proc, proc));
  return laid.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        const dir = yield* run(["rev-parse", "--absolute-git-dir"]);
        if (dir.status !== 0 || !isAbsolute(dir.stdout.trim())) return;
        const file = join(dir.stdout.trim(), PROFILE_EXCLUDE);
        if ((yield* run(["config", "extensions.worktreeConfig", "true"])).status !== 0) return;
        const set = (yield* run([
          "config",
          "--worktree",
          "--get",
          "core.excludesFile",
        ])).stdout.trim();
        if (set !== "" && set !== file) return;
        yield* Effect.promise(async () => {
          const have = new Set((await readFile(file, "utf8").catch(() => "")).split("\n"));
          // Anchored at the top and escaped, so a name is that one file and never a pattern.
          const lines = laid
            .map((path) => `/${path.replace(/[\\[\]*?!# ]/g, "\\$&")}`)
            .filter((line) => !have.has(line));
          if (lines.length > 0) await appendFile(file, `${lines.join("\n")}\n`, "utf8");
        });
        yield* run(["config", "--worktree", "core.excludesFile", file]);
      }).pipe(Effect.ignore);
};
