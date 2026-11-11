// Laying a profile's files in a folder, and keeping them out of a repository's commits. Used where
// the folder is: by the server for a thread of its own machine, by a machine's host for one placed
// there (`host/thread-places.ts`).
import { InvalidState, type ProfileFile } from "@gram/contracts";
import { git, Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

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

/**
 * Keeps the files a profile laid in a checkout out of its commits: each is named in the
 * repository's own `info/exclude`, which no clone or push carries. Without it an agent's
 * `git add` would put the supplier's skills into the repository's history. Best effort: a
 * repository that can't say where its exclude file is keeps the files visible.
 */
export const excludeLaid = (
  proc: ProcShape,
  checkout: string,
  laid: ReadonlyArray<string>,
): Effect.Effect<void> =>
  laid.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        const out = yield* git(checkout, ["rev-parse", "--git-path", "info/exclude"]).pipe(
          Effect.provideService(Proc, proc),
        );
        if (out.status !== 0 || out.stdout.trim() === "") return;
        const named = out.stdout.trim();
        const file = isAbsolute(named) ? named : join(checkout, named);
        yield* Effect.promise(async () => {
          const have = new Set((await readFile(file, "utf8").catch(() => "")).split("\n"));
          // Anchored at the top and escaped, so a name is that one file and never a pattern.
          const lines = laid
            .map((path) => `/${path.replace(/[\\[\]*?!# ]/g, "\\$&")}`)
            .filter((line) => !have.has(line));
          if (lines.length === 0) return;
          await mkdir(dirname(file), { recursive: true });
          await appendFile(file, `${lines.join("\n")}\n`, "utf8");
        });
      }).pipe(Effect.ignore);
