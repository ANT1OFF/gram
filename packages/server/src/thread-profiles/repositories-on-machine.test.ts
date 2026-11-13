// A profile's workplace of repositories placed on a joined machine, on real git: the machine
// clones, so this server never reaches the remote. It files the thread under a repository that
// holds only the remote's address, and hands the ref to the machine to resolve.
import { describe, expect, it } from "@effect/vitest";
import {
  type Checkout,
  type CheckoutRequest,
  HostId,
  InvalidState,
  ThreadId,
} from "@gram/contracts";
import { Proc, ProcLive, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { hasGit, removeDir, tempDir } from "../git/test-repo.ts";
import {
  makeProfileRepositories,
  PROFILE_ORIGINS_DIR,
  PROFILE_REPOS_DIR,
  profileBranchOf,
} from "./repositories.ts";

const MACHINE = HostId.make("machine-1");
const THREAD = ThreadId.make("0b6c1d1e-6a39-4c8a-9a4e-6f2b8c1d2e3f");
// Names no host that answers: a clone or a fetch here would fail the test.
const APP = "https://git.example.test/acme/app";
const DOCS = "https://git.example.test/acme/docs.git";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** Every git command this server runs, and the machine's prepare as the server sees it. */
const setup = (proc: ProcShape) => {
  const dataDir = tempDir();
  const commands: Array<ReadonlyArray<string>> = [];
  const asked: Array<{ request: CheckoutRequest; projectRoot: string; origin: string }> = [];
  const projects: Array<{ root: string; name: string }> = [];
  const repositories = makeProfileRepositories({
    proc: Proc.of({
      run: (bin, args, options) => {
        if (bin === "git") commands.push(args);
        return proc.run(bin, args, options);
      },
    }),
    dataDir,
    ensureProject: (input) => Effect.sync(() => projects.push(input)),
    // What a joined machine's worker host does with it: reads the origin here, clones there.
    prepare: (request, projectRoot) =>
      Effect.sync((): Checkout => {
        asked.push({
          request,
          projectRoot,
          origin: git(projectRoot, "remote", "get-url", "origin"),
        });
        return {
          kind: "worktree",
          path: `/machine/repos/${asked.length}/.worktrees/t`,
          hostId: MACHINE,
          ...(request.kind === "newWorktree" ? { branch: request.branch } : {}),
        };
      }),
    discard: () => Effect.void,
  });
  return { dataDir, commands, asked, projects, repositories };
};

const withSetup = <A, E>(
  body: (made: ReturnType<typeof setup>) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const made = setup(yield* Proc);
    yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(made.dataDir)));
    return yield* body(made);
  }).pipe(Effect.scoped, Effect.provide(ProcLive));

describe.skipIf(!hasGit)("a profile's repositories on a joined machine", () => {
  it.live("are cloned only on the machine: this server keeps their address and nothing else", () =>
    withSetup(({ dataDir, commands, asked, projects, repositories }) =>
      Effect.gen(function* () {
        const place = yield* repositories.prepare(
          THREAD,
          [{ url: APP, ref: "release", branch: "agent/fix" }, { url: DOCS }],
          MACHINE,
        );

        // Nothing here reached a remote: no clone, fetch or listing of one.
        for (const args of commands)
          expect(args.some((arg) => ["clone", "fetch", "ls-remote", "pull"].includes(arg))).toBe(
            false,
          );
        expect(existsSync(join(dataDir, PROFILE_REPOS_DIR))).toBe(false);

        // The machine was asked for a worktree of each, from the address as the profile gave it,
        // with the ref left for the machine to resolve against its own clone.
        expect(asked.map(({ request, origin }) => ({ request, origin }))).toEqual([
          {
            request: {
              kind: "newWorktree",
              branch: "agent/fix",
              base: "release",
              hostId: MACHINE,
            },
            origin: APP,
          },
          {
            request: { kind: "newWorktree", branch: profileBranchOf(THREAD), hostId: MACHINE },
            origin: DOCS,
          },
        ]);
        expect(place.checkout.hostId).toBe(MACHINE);
        expect(place.extraCheckouts).toHaveLength(1);

        // What the thread is filed under is a repository with the origin and no history.
        expect(place.projectRoot.startsWith(join(dataDir, PROFILE_ORIGINS_DIR))).toBe(true);
        expect(projects.map((project) => project.name)).toEqual(["app", "docs"]);
        expect(git(place.projectRoot, "config", "--local", "--get", "remote.origin.url")).toBe(APP);
        expect(() =>
          execFileSync("git", ["-C", place.projectRoot, "rev-parse", "--verify", "-q", "HEAD"], {
            stdio: "ignore",
          }),
        ).toThrow();
      }),
    ),
  );

  it.live("keep one address folder per remote, and refuse a folder holding another", () =>
    withSetup(({ dataDir, asked, repositories }) =>
      Effect.gen(function* () {
        const first = yield* repositories.prepare(THREAD, [{ url: APP }], MACHINE);
        const again = yield* repositories.prepare(THREAD, [{ url: APP }], MACHINE);
        expect(again.projectRoot).toBe(first.projectRoot);
        expect(asked).toHaveLength(2);

        // Something else put in its place is never taken for it.
        git(first.projectRoot, "remote", "set-url", "origin", "https://git.example.test/evil/app");
        const refused = yield* repositories
          .prepare(THREAD, [{ url: APP }], MACHINE)
          .pipe(Effect.flip);
        expect(refused).toBeInstanceOf(InvalidState);
        expect(refused.message).toMatch(/already holds a different origin/);

        // Nor is a folder reached through a link.
        const elsewhere = tempDir();
        yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(elsewhere)));
        const origins = join(dataDir, PROFILE_ORIGINS_DIR, "git.example.test");
        mkdirSync(origins, { recursive: true });
        symlinkSync(elsewhere, join(origins, "linked"));
        const linked = yield* repositories
          .prepare(THREAD, [{ url: "https://git.example.test/linked/app.git" }], MACHINE)
          .pipe(Effect.flip);
        expect(linked.message).toMatch(/isn't a folder of its own/);
        expect(asked).toHaveLength(2);
      }),
    ),
  );

  it.live("refuse an address the host doesn't clone, before anything is made", () =>
    withSetup(({ dataDir, asked, repositories }) =>
      Effect.gen(function* () {
        const refused = yield* repositories
          .prepare(THREAD, [{ url: "file:///etc/app" }], MACHINE)
          .pipe(Effect.flip);
        expect(refused.message).toMatch(/isn't an https or ssh URL/);
        expect(asked).toEqual([]);
        expect(existsSync(join(dataDir, PROFILE_ORIGINS_DIR))).toBe(false);
      }),
    ),
  );
});
