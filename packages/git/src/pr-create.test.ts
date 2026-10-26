import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createPr, PrCreateFailed, prDraftFromCommits } from "./pr-create.ts";
import { Proc, ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const commit = (cwd: string, file: string, message: string) => {
  write(nodePath.join(cwd, file), file);
  run(cwd, "add", "-A");
  run(cwd, "commit", "-qm", message);
};

/** A `Proc` that answers every command with `output` and records what was run. */
const fakeGh = (output: { status: number; stdout: string; stderr?: string }) => {
  const calls: Array<{ bin: string; args: ReadonlyArray<string>; stdin?: string | undefined }> = [];
  const layer = Layer.succeed(Proc, {
    run: (bin, args, options) =>
      Effect.sync(() => {
        calls.push({ bin, args, stdin: options.stdin });
        return {
          status: output.status,
          stdout: output.stdout,
          stderr: output.stderr ?? "",
          truncated: false,
        };
      }),
  });
  return { calls, layer };
};

describe("createPr", () => {
  it.effect("runs gh pr create with the body on stdin and reads the new PR from its URL", () =>
    Effect.gen(function* () {
      const gh = fakeGh({ status: 0, stdout: "\nhttps://github.com/acme/web/pull/42\n" });
      const created = yield* createPr("/repo", {
        title: "Add dark mode",
        body: '- Toggle\n- Tokens with 100% & "quotes"',
        base: "main",
        draft: true,
      }).pipe(Effect.provide(gh.layer));

      expect(created).toEqual({
        repo: "acme/web",
        number: 42,
        url: "https://github.com/acme/web/pull/42",
      });
      expect(gh.calls).toEqual([
        {
          bin: "gh",
          args: [
            "pr",
            "create",
            "--title",
            "Add dark mode",
            "--body-file",
            "-",
            "--base",
            "main",
            "--draft",
          ],
          stdin: '- Toggle\n- Tokens with 100% & "quotes"',
        },
      ]);
    }),
  );

  it.effect("says what gh said when it refuses, or when it prints no PR", () =>
    Effect.gen(function* () {
      const exists = yield* Effect.flip(
        createPr("/repo", { title: "t", body: "", base: "main", draft: false }).pipe(
          Effect.provide(
            fakeGh({
              status: 1,
              stdout: "",
              stderr: 'a pull request for branch "feat/x" already exists',
            }).layer,
          ),
        ),
      );
      expect(exists).toBeInstanceOf(PrCreateFailed);
      expect(exists.message).toBe('a pull request for branch "feat/x" already exists');

      const silent = yield* Effect.flip(
        createPr("/repo", { title: "t", body: "", base: "main", draft: false }).pipe(
          Effect.provide(fakeGh({ status: 0, stdout: "Creating pull request…" }).layer),
        ),
      );
      expect(silent.message).toBe("gh pr create didn't print a PR URL: Creating pull request…");
    }),
  );
});

describe.skipIf(!hasGit)("prDraftFromCommits", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("uses a lone commit's subject and body, else the thread title and a list", () =>
    Effect.gen(function* () {
      const root = tempDir();
      dirs.push(root);
      const repo = makeRepo(root);
      run(repo, "checkout", "-q", "-b", "feat/dark");

      expect(yield* prDraftFromCommits(repo, "main", "Add dark mode toggle")).toEqual({
        title: "Add dark mode toggle",
        body: "",
        commits: 0,
      });

      write(nodePath.join(repo, "toggle.ts"), "toggle");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "Add a dark mode toggle", "-m", "Persists the choice per user.");
      expect(yield* prDraftFromCommits(repo, "main", "Add dark mode toggle")).toEqual({
        title: "Add a dark mode toggle",
        body: "Persists the choice per user.",
        commits: 1,
      });

      commit(repo, "tokens.ts", "Add dark palette tokens");
      expect(yield* prDraftFromCommits(repo, "main", "Add dark mode toggle")).toEqual({
        title: "Add dark mode toggle",
        body: "- Add a dark mode toggle\n- Add dark palette tokens",
        commits: 2,
      });
    }).pipe(Effect.provide(ProcLive)),
  );
});
