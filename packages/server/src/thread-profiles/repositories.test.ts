// A profile whose workplace is repositories, through the RPC handler, on real git and the fake
// agent: the remote is a bare repository on this disk, reached through `insteadOf`.
import { describe, expect, it } from "@effect/vitest";
import { applySettingsPatch, InvalidState, type ThreadProfile } from "@gram/contracts";
import { Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ServerConfig } from "../config.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { hasGit, makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
import { GitTurnHooksLive } from "../git/turn-hooks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { threadHandlers } from "../rpc/handlers/threads.ts";
import { FakeAgentAdapter, FakeAgentControl } from "../runtime/fake-agent.ts";
import { ServerCore } from "../http/server.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { PROFILE_REPOS_DIR, profileBranchOf } from "./repositories.ts";

const APP = "https://git.example.test/acme/app.git";
const DOCS = "https://git.example.test/acme/docs.git";

const scratch = tempDir();
afterAll(() => removeDir(scratch));

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** How many worktrees the clone at `repoRoot` has, its own checkout among them. */
const worktreesOf = (repoRoot: string) =>
  git(repoRoot, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

/** A bare repository on this disk standing in for the remote at `url`. */
const remote = (name: string, prepare: (work: string) => void = () => {}) => {
  const work = makeRepo(join(scratch, `${name}-work`));
  prepare(work);
  const bare = join(scratch, `${name}.git`);
  execFileSync("git", ["clone", "--quiet", "--bare", work, bare]);
  return bare;
};

const remotes = hasGit
  ? {
      [APP]: remote("app", (work) => {
        // The repository's own instructions, a release branch and a tag.
        execFileSync("git", ["-C", work, "checkout", "-q", "-b", "release"]);
        execFileSync("sh", ["-c", `echo "# The app's own rules" > "${join(work, "AGENTS.md")}"`]);
        execFileSync("git", ["-C", work, "add", "-A"]);
        execFileSync("git", ["-C", work, "commit", "-qm", "release rules"]);
        execFileSync("git", ["-C", work, "tag", "v1"]);
        execFileSync("git", ["-C", work, "checkout", "-q", "main"]);
      }),
      [DOCS]: remote("docs"),
    }
  : {};

/** What lets the server's clones and fetches reach those remotes, for these two addresses only. */
const GIT_ENV: Record<string, string> = {
  GIT_ALLOW_PROTOCOL: "https:ssh:file",
  GIT_CONFIG_COUNT: String(Object.keys(remotes).length),
  ...Object.fromEntries(
    Object.entries(remotes).flatMap(([url, bare], i) => [
      [`GIT_CONFIG_KEY_${i}`, `url.file://${bare}.insteadOf`],
      [`GIT_CONFIG_VALUE_${i}`, url],
    ]),
  ),
};

const ProcToLocalRemotes = Layer.effect(
  Proc,
  Effect.map(Proc, (proc) =>
    Proc.of({
      // Only where git talks to the remote: read back, `origin` is the address it was given.
      run: (bin, args, options) =>
        bin === "git" && args.some((arg) => arg === "clone" || arg === "fetch")
          ? proc.run(bin, args, { ...options, env: { ...options.env, ...GIT_ENV } })
          : proc.run(bin, args, options),
    }),
  ),
).pipe(Layer.provide(ProcLive));

const serverOver = (dataDir: string) =>
  ServerCore.pipe(
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(GitTurnHooksLive),
    Layer.provideMerge(gitPlatformTest({ proc: ProcToLocalRemotes })),
    Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, dataDir })),
    Layer.orDie,
  );

const withServer = <A, E>(
  body: (dataDir: string) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof serverOver>>>,
) =>
  Effect.suspend(() => {
    const dataDir = tempDir();
    return body(dataDir).pipe(
      Effect.provide(serverOver(dataDir)),
      Effect.ensuring(Effect.sync(() => removeDir(dataDir))),
    );
  });

const profile = (over: Partial<ThreadProfile> = {}): ThreadProfile => ({
  version: 1,
  name: "Fix the build",
  agent: "claude",
  charter: "Fix what is asked, and open a pull request.",
  files: [
    { path: "AGENTS.md", content: "# The supplier's rules\n" },
    { path: "notes/brief.md", content: "The brief.\n" },
  ],
  skills: [{ name: "ship-it", description: "Ships.", body: "Run the checks." }],
  model: { model: "fake-model" },
  connectors: {},
  workplace: { kind: "repositories", repositories: [{ url: APP }] },
  ...over,
});

const start = (value: unknown) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: true } }),
      [["experimental", "embedding"]],
    );
    const handlers = yield* threadHandlers;
    return yield* handlers["thread.createFromProfile"]({ profile: value });
  });

describe.skipIf(!hasGit)("thread.createFromProfile in repositories", () => {
  it.live("clones the repository and starts the thread in a worktree on a branch of its own", () =>
    withServer((dataDir) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const thread = yield* start(profile());

        const { checkout } = thread;
        expect(checkout.kind).toBe("worktree");
        expect(checkout.branch).toBe(profileBranchOf(thread.id));
        // The clone is under the data folder, and is the project the thread is filed under.
        expect(checkout.repoRoot?.startsWith(join(dataDir, PROFILE_REPOS_DIR))).toBe(true);
        const project = (yield* store.listProjects).find((p) => p.id === thread.projectId);
        expect(project).toMatchObject({ root: checkout.repoRoot, name: "app" });
        expect(git(checkout.path, "rev-parse", "HEAD")).toBe(
          git(checkout.repoRoot!, "rev-parse", "origin/main"),
        );

        // The files and the skill are in the worktree, and git sees none of them as changes.
        expect(readFileSync(join(checkout.path, "AGENTS.md"), "utf8")).toBe(
          "# The supplier's rules\n",
        );
        expect(existsSync(join(checkout.path, ".claude/skills/ship-it/SKILL.md"))).toBe(true);
        expect(git(checkout.path, "status", "--porcelain")).toBe("");

        const session = fake.sessions.find((s) => s.options.threadId === thread.id);
        expect(session?.options.cwd).toBe(checkout.path);
        expect(session?.options.instructions).toBe("Fix what is asked, and open a pull request.");
        expect(session?.options.mcpAllowlist).toEqual([]);
      }),
    ),
  );

  it.live(
    "starts from the ref named, on the branch named, and leaves the repository's own files",
    () =>
      withServer(() =>
        Effect.gen(function* () {
          const thread = yield* start(
            profile({
              workplace: {
                kind: "repositories",
                repositories: [{ url: APP, ref: "release", branch: "agent/fix-build" }],
              },
            }),
          );
          const { checkout } = thread;
          expect(checkout.branch).toBe("agent/fix-build");
          expect(git(checkout.path, "rev-parse", "HEAD")).toBe(
            git(checkout.repoRoot!, "rev-parse", "origin/release"),
          );
          // The repository has an AGENTS.md of its own there, which stays; the rest is laid.
          expect(readFileSync(join(checkout.path, "AGENTS.md"), "utf8")).toBe(
            "# The app's own rules\n",
          );
          expect(readFileSync(join(checkout.path, "notes/brief.md"), "utf8")).toBe("The brief.\n");
          expect(git(checkout.path, "status", "--porcelain")).toBe("");

          // A tag is a ref too.
          const tagged = yield* start(
            profile({
              workplace: { kind: "repositories", repositories: [{ url: APP, ref: "v1" }] },
            }),
          );
          expect(git(tagged.checkout.path, "rev-parse", "HEAD")).toBe(
            git(tagged.checkout.repoRoot!, "rev-parse", "v1^{commit}"),
          );
        }),
      ),
  );

  it.live("gives the thread its other repositories beside the first", () =>
    withServer(() =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        const thread = yield* start(
          profile({
            workplace: { kind: "repositories", repositories: [{ url: APP }, { url: DOCS }] },
          }),
        );
        expect(thread.extraCheckouts).toHaveLength(1);
        const [docs] = thread.extraCheckouts!;
        expect(docs?.branch).toBe(profileBranchOf(thread.id));
        expect(thread.additionalDirectories).toEqual([docs?.path]);
        // The files are laid in the first only.
        expect(existsSync(join(docs!.path, "AGENTS.md"))).toBe(false);
        const session = fake.sessions.find((s) => s.options.threadId === thread.id);
        expect(session?.options.additionalDirectories).toEqual([docs?.path]);
      }),
    ),
  );

  it.live("makes nothing when a repository or a ref can't be had", () =>
    withServer(() =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        // A first thread, so the clones exist to be counted.
        const first = yield* start(
          profile({
            workplace: { kind: "repositories", repositories: [{ url: APP }, { url: DOCS }] },
          }),
        );
        const app = first.checkout.repoRoot!;
        const before = worktreesOf(app);

        const refusals: ReadonlyArray<readonly [string, ThreadProfile["workplace"], string]> = [
          [
            "a ref the repository doesn't have",
            { kind: "repositories", repositories: [{ url: APP, ref: "no-such-branch" }] },
            "isn't a branch, tag or commit",
          ],
          [
            "a second repository that can't be cloned, after the first got its worktree",
            {
              kind: "repositories",
              repositories: [{ url: APP }, { url: "https://git.example.test/acme/missing.git" }],
            },
            "clone",
          ],
          [
            "an address that isn't a remote",
            { kind: "repositories", repositories: [{ url: "file:///etc" }] },
            "https or ssh",
          ],
          [
            "a credential in the address",
            {
              kind: "repositories",
              repositories: [{ url: "https://user:token@git.example.test/acme/app.git" }],
            },
            "credentials",
          ],
        ];
        for (const [what, workplace, says] of refusals) {
          const refused = yield* start(profile({ workplace })).pipe(Effect.flip);
          expect(refused, what).toBeInstanceOf(InvalidState);
          expect(refused.message, what).toContain(says);
        }
        expect((yield* store.listThreads).map((t) => t.id)).toEqual([first.id]);
        expect(fake.sessions.filter((s) => s.options.threadId !== first.id)).toEqual([]);
        expect(worktreesOf(app)).toBe(before);
      }),
    ),
  );

  it.live("writes nothing through a link the repository has where a file would go", () =>
    withServer(() =>
      Effect.gen(function* () {
        const outside = join(scratch, `outside-${Date.now()}`);
        execFileSync("mkdir", ["-p", outside]);
        // A repository whose `notes` is a link out of the checkout.
        const bare = remotes[APP]!;
        const work = join(scratch, `link-work-${Date.now()}`);
        execFileSync("git", ["clone", "--quiet", bare, work]);
        symlinkSync(outside, join(work, "notes"));
        git(work, "add", "-A");
        git(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a link");
        git(work, "push", "-q", "origin", "HEAD:refs/heads/linked");

        const refused = yield* start(
          profile({
            workplace: { kind: "repositories", repositories: [{ url: APP, ref: "linked" }] },
          }),
        ).pipe(Effect.flip);
        expect(refused).toBeInstanceOf(InvalidState);
        expect(refused.message).toContain("notes/brief.md");
        expect(existsSync(join(outside, "brief.md"))).toBe(false);
      }),
    ),
  );
});
