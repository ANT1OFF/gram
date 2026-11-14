// merge_when_ready at full autonomy: what the agent can fix itself is refused to it with the fix,
// never put to the user; dropping an intent and a merged PR need neither ownership nor a card.
import { describe, expect, it } from "@effect/vitest";
import { HostId } from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import { spawnSync } from "node:child_process";
import * as Fiber from "effect/Fiber";
import { hasGit, run } from "../git/test-repo.ts";
import { cloneIdentityOf } from "../host/repos.ts";
import { workerPrOwnership } from "../git/worker-pr.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  publishGit,
  settle,
  spawn,
  waitReal,
  withServer,
} from "../orchestration/test-harness.ts";
import { armedWorkerBadge, badge } from "./pr-tools-kit.ts";
import { AppToolRegistry } from "./registry.ts";

/** The deploy PR a release script opened from a scratch worktree it then removed. */
const DEPLOY = "release/prod-6d5d5050";

describe("merge_when_ready guidance at full autonomy", () => {
  it.effect.skipIf(!hasGit)(
    "refuses a PR whose branch the worktree doesn't hold with the fix, then merges it once held",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "release" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(21, { headRefName: DEPLOY });
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(false);
            const refused = yield* merge.run({ pr: 21 }).pipe(Effect.flip);
            expect(refused.message).toBe(
              `Full auto covers only a worker's own pull request: one whose head branch is checked out in the worktree Gram gave the worker. acme/app#21's head branch \`${DEPLOY}\` isn't checked out there. Check it out in the worktree Gram gave you (\`git fetch origin ${DEPLOY}\` then \`git switch ${DEPLOY}\`; commit your own work first), then call merge_when_ready again; Gram then merges it once its checks pass without asking. That holds only while no other thread has it as its pull request or holds its branch: checking out another thread's branch never makes it yours. The user wasn't asked, and their approval isn't the way through for this.`,
            );
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            expect((yield* store.getThread(worker.thread.id)).boundPr).toBeUndefined();

            // Following the fix: the branch checked out in its own worktree makes the PR its own.
            run(worker.thread.checkout.path, "switch", "-q", "-c", DEPLOY);
            expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(true);
            yield* merge.run({ pr: 21 });
            expect((yield* store.getThread(worker.thread.id)).boundPr).toMatchObject({
              number: 21,
              mergeWhenReady: { allowedBy: "autonomy" },
            });
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const claim of ["bound", "held"] as const) {
    it.effect.skipIf(!hasGit)(
      `checking out a sibling's ${claim === "bound" ? "bound PR's branch" : "branch"} doesn't make it the worker's own`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "taker" });
              const sibling = yield* spawn(session, { feature: "owner" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full");
              const theirs = sibling.thread.checkout.branch!;
              world.prHeads.set(30, { headRefName: theirs });
              if (claim === "bound") {
                // The sibling's PR, its branch since left in the sibling's worktree.
                yield* runtimes.updateThread(sibling.thread.id, (t) => ({
                  ...t,
                  boundPr: { repo: "acme/app", number: 30, monitor: false },
                }));
                run(sibling.thread.checkout.path, "switch", "-q", "--detach");
                run(worker.thread.checkout.path, "switch", "-q", theirs);
              } else {
                // Still checked out in the sibling's worktree; forced out here as well.
                run(
                  worker.thread.checkout.path,
                  "checkout",
                  "-q",
                  "--ignore-other-worktrees",
                  theirs,
                );
              }
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 30 })).toBe(false);
              const call = yield* Effect.forkScoped(merge.run({ pr: 30 }).pipe(Effect.flip));
              const card = yield* waitReal(
                "the approval card",
                store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
              );
              if (card.kind !== "approval") throw new Error("not an approval");
              expect(card.autonomyNote).toBe(
                "full auto, PR ownership unverified: another thread has it as its pull request, or holds its branch in a worktree of its own, so it is that thread's work even where the worker has the branch checked out",
              );
              yield* runtimes.respond(worker.thread.id, card.id, {
                kind: "approval",
                decision: "deny",
                scope: "once",
              });
              expect((yield* Fiber.join(call)).message).toContain(
                "Leave it to the thread that holds it",
              );
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  /**
   * What a worker on a joined machine holds `feat/remote-held` under, as Gram recorded its clone:
   * the project's own origin, its aliases (which name the same repository), an identity that names
   * none, and another repository. Only the last claims nothing.
   */
  const REMOTE_IDENTITIES = [
    { label: "the project's origin", identity: cloneIdentityOf("https://github.com/acme/app.git") },
    { label: "it without .git", identity: cloneIdentityOf("https://github.com/acme/app") },
    { label: "its scp form", identity: cloneIdentityOf("git@github.com:acme/app.git") },
    {
      label: "its ssh form in other case",
      identity: cloneIdentityOf("ssh://git@github.com/ACME/App.git"),
    },
    { label: "an identity naming no repository", identity: "not-an-identity" },
    // The .git suffix in mixed case, as git and GitHub take it: still the project's repository.
    { label: "a .GIT suffix", identity: cloneIdentityOf("https://github.com/acme/app.GIT") },
    { label: "a .Git suffix", identity: cloneIdentityOf("https://github.com/acme/app.Git") },
    {
      label: "a .gIt suffix in scp form",
      identity: cloneIdentityOf("git@github.com:acme/app.gIt"),
    },
    { label: "an encoded owner", identity: cloneIdentityOf("https://github.com/%61cme/app.git") },
    {
      label: "an encoded repository",
      identity: cloneIdentityOf("https://github.com/acme/%61pp.git"),
    },
    {
      label: "an encoded separator",
      identity: cloneIdentityOf("https://github.com/acme%2Fapp.git"),
    },
    // Cyrillic а in place of a: recorded as its clone would be, whether or not a URL reads back.
    {
      label: "a lookalike character",
      identity: JSON.stringify(["https:", "github.com", "443", "", "/acme/\u0430pp.git"]),
    },
    { label: "a subpath", identity: cloneIdentityOf("https://github.com/prefix/acme/app.git") },
    {
      label: "a numeric subpath",
      identity: cloneIdentityOf("https://github.com/123/acme/app.git"),
    },
    {
      label: "an extra segment",
      identity: cloneIdentityOf("https://github.com/acme/app/extra.git"),
    },
    {
      label: "an enterprise host",
      identity: cloneIdentityOf("https://ghe.example.test/elsewhere/other.git"),
    },
    // Hosts spelled like inherited object keys, naming another repository.
    {
      label: "a constructor host",
      identity: cloneIdentityOf("https://constructor/elsewhere/other.git"),
    },
    {
      label: "a __proto__ host",
      identity: cloneIdentityOf("https://__proto__/elsewhere/other.git"),
    },
    {
      label: "another repository",
      identity: cloneIdentityOf("https://github.com/elsewhere/other.git"),
    },
  ] as const;
  const MACHINE = HostId.make("m-0123456789abcdef01234567");
  const REMOTE_BRANCH = "feat/remote-held";
  /** A sibling that only follows `number` and holds `branch` in a worktree on the joined machine. */
  const remoteHolder = (
    runtimes: ThreadRuntimes["Service"],
    id: Parameters<ThreadRuntimes["Service"]["updateThread"]>[0],
    identity: string,
    branch: string,
    number: number,
  ) =>
    runtimes.updateThread(id, (t) => ({
      ...t,
      extraPrs: [{ repo: "acme/app", number, monitor: true }],
      checkout: {
        kind: "worktree" as const,
        path: "/synthetic/worktree",
        repoRoot: "/synthetic/clone",
        branch,
        hostId: MACHINE,
        cloneIdentity: identity,
      },
    }));

  for (const { label, identity } of REMOTE_IDENTITIES) {
    const claims = label !== "another repository";
    it.effect.skipIf(!hasGit)(
      `a branch a live worker holds on another machine under ${label} ${claims ? "stays that worker's" : "claims nothing"}`,
      () =>
        Effect.gen(function* () {
          expect(identity).toBeDefined();
          const world = yield* makeWorld;
          world.joinedMachine = {
            id: MACHINE,
            online: true,
            worktrees: new Map([
              [
                "/synthetic/worktree",
                {
                  clone: "/synthetic/clone",
                  origin: "https://github.com/acme/app.git",
                  branch: REMOTE_BRANCH,
                },
              ],
            ]),
          };
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "local-adopter" });
              const sibling = yield* spawn(session, { feature: "remote-holder" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full");
              yield* remoteHolder(runtimes, sibling.thread.id, identity!, REMOTE_BRANCH, 21);
              world.prHeads.set(21, { headRefName: REMOTE_BRANCH });
              run(worker.thread.checkout.path, "switch", "-q", "-c", REMOTE_BRANCH);
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({ pr: 21 })).toBe(!claims);
              if (!claims) return;
              const call = yield* Effect.forkScoped(merge.run({ pr: 21 }).pipe(Effect.flip));
              const card = yield* waitReal(
                "the approval card",
                store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
              );
              if (card.kind !== "approval") throw new Error("not an approval");
              expect(card.autonomyNote).toContain("another thread has it as its pull request");
              yield* runtimes.respond(worker.thread.id, card.id, {
                kind: "approval",
                decision: "deny",
                scope: "once",
              });
              yield* Fiber.join(call);
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)(
    "a branch recorded for a sibling's folder under another machine's id still claims it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "taker" });
            const sibling = yield* spawn(session, { feature: "recorded-holder" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            const recorded = "feat/recorded-elsewhere";
            // The sibling's folder is on its own branch; the record of the PR's branch names a
            // machine, as no record Gram writes does, and must still count.
            yield* runtimes.updateThread(sibling.thread.id, (t) => ({
              ...t,
              ownedBranches: [
                { path: sibling.thread.checkout.path, branch: recorded, hostId: MACHINE },
              ],
            }));
            world.prHeads.set(31, { headRefName: recorded });
            run(worker.thread.checkout.path, "switch", "-q", "-c", recorded);
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            expect(yield* merge.delegatedAtFullAutonomy!({ pr: 31 })).toBe(false);
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "renaming the shared origin to an alias of its repository keeps a remote holder's claim",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const projectOrigin = "https://github.com/acme/app.git";
        run(world.repo, "remote", "add", "origin", projectOrigin);
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "local-adopter-real" });
            const sibling = yield* spawn(session, { feature: "remote-holder-real" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            yield* remoteHolder(
              runtimes,
              sibling.thread.id,
              cloneIdentityOf(projectOrigin)!,
              REMOTE_BRANCH,
              21,
            );
            run(worker.thread.checkout.path, "switch", "-q", "-c", REMOTE_BRANCH);
            // Real git for origins and branches; gh describes the PR, and nothing else runs.
            const proc = {
              run: (bin: string, args: ReadonlyArray<string>, options: { readonly cwd: string }) =>
                Effect.sync(() => {
                  if (bin === "git") {
                    const out = spawnSync("git", [...args], { cwd: options.cwd, encoding: "utf8" });
                    return {
                      status: out.status ?? 1,
                      stdout: out.stdout,
                      stderr: out.stderr,
                      truncated: false,
                    };
                  }
                  if (bin === "gh" && args[0] === "pr" && args[1] === "view")
                    return {
                      status: 0,
                      stdout: JSON.stringify({
                        number: 21,
                        url: "https://github.com/acme/app/pull/21",
                        title: "t",
                        headRefName: REMOTE_BRANCH,
                        isCrossRepository: false,
                        state: "OPEN",
                        headRefOid: "h1",
                      }),
                      stderr: "",
                      truncated: false,
                    };
                  throw new Error(`unexpected ${bin} ${args.join(" ")}`);
                }),
            };
            const ownership = (origin: string) =>
              Effect.gen(function* () {
                run(worker.thread.checkout.path, "remote", "set-url", "origin", origin);
                const local = yield* store.getThread(worker.thread.id);
                return yield* workerPrOwnership(local, "acme/app", 21).pipe(
                  Effect.provideService(Proc, proc as never),
                );
              });
            for (const origin of [
              projectOrigin,
              "https://github.com/acme/app",
              "git@github.com:acme/app.git",
              "https://github.com/ACME/App.git",
              "https://github.com/acme/app.GIT",
              "git@github.com:acme/app.gIt",
            ])
              expect(yield* ownership(origin)).toBe("another thread binds it or holds its branch");
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const { label, identity } of REMOTE_IDENTITIES.filter((each) =>
    [
      "it without .git",
      "its scp form",
      "an encoded owner",
      "an encoded repository",
      "a lookalike character",
      "a subpath",
      "an extra segment",
      "a constructor host",
      "a __proto__ host",
      "a .GIT suffix",
      "a .Git suffix",
      "a .gIt suffix in scp form",
    ].includes(each.label),
  )) {
    it.effect.skipIf(!hasGit)(
      `a worker on another machine taking the armed PR's branch under ${label} during the fresh read stops its merge`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "armed" });
              const sibling = yield* spawn(session, { feature: "late-holder" });
              yield* completeTurn(worker.session);
              yield* completeTurn(sibling.session);
              yield* atAutonomy(thread, "full");
              const branch = worker.thread.checkout.branch!;
              world.prHeads.set(12, { headRefName: branch });
              const tools = registry.forTransport(worker.thread.id, "worker");
              yield* tools
                .find((t) => t.descriptor.name === "pr_bind")!
                .run({ repo: "acme/app", number: 12 });
              const publish = (approved: boolean) =>
                store
                  .getThread(worker.thread.id)
                  .pipe(
                    Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                  );
              yield* publish(false);
              yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toMatchObject({ allowedBy: "autonomy" });
              let claimed = false;
              world.freshPrRead = Effect.suspend(() => {
                world.freshPrRead = undefined;
                return remoteHolder(runtimes, sibling.thread.id, identity!, branch, 12).pipe(
                  Effect.tap(() => Effect.sync(() => void (claimed = true))),
                  Effect.asVoid,
                  Effect.orDie,
                );
              });
              yield* publish(true);
              yield* waitReal(
                "the claim",
                Effect.sync(() => claimed || undefined),
              );
              yield* settle;
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const state of ["MERGED", "CLOSED"] as const) {
    it.effect.skipIf(!hasGit)(
      `set_auto_merge refuses an unbound ${state.toLowerCase()} PR without a card`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "ended-unbound" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, "full", { mergeReviewPolicy: "bot" });
              world.prHeads.set(21, { headRefName: worker.thread.checkout.branch!, state });
              yield* publishGit(world, worker.thread, {
                pr: badge({ number: 21, url: "https://github.com/acme/app/pull/21", state }),
              });
              const tool = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "set_auto_merge")!;
              const refused = yield* tool.run({ number: 21 }).pipe(Effect.flip);
              expect(refused.message).toBe(
                `acme/app#21 is ${state.toLowerCase()}, so there is nothing to merge; check it with pr_status. Nobody was asked.`,
              );
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const when of ["before the launch", "during the fresh read"] as const) {
    it.effect.skipIf(!hasGit)(`a sibling binding the armed PR ${when} stops its merge`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "armed" });
            const sibling = yield* spawn(session, { feature: "claimant" });
            yield* completeTurn(worker.session);
            yield* completeTurn(sibling.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            const tools = registry.forTransport(worker.thread.id, "worker");
            yield* tools
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({
                repo: "acme/app",
                number: 12,
              });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
            expect(
              (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
            ).toMatchObject({ allowedBy: "autonomy" });
            const claim = runtimes
              .updateThread(sibling.thread.id, (t) => ({
                ...t,
                boundPr: { repo: "acme/app", number: 12, monitor: false },
              }))
              .pipe(Effect.asVoid, Effect.orDie);
            let claimed = false;
            if (when === "before the launch") {
              yield* claim;
              claimed = true;
            } else
              world.freshPrRead = Effect.suspend(() => {
                world.freshPrRead = undefined;
                return claim.pipe(Effect.tap(() => Effect.sync(() => void (claimed = true))));
              });
            yield* publish(true);
            yield* waitReal(
              "the claim",
              Effect.sync(() => claimed || undefined),
            );
            yield* settle;
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  /**
   * A worker's own PR, its branch held in the worktree Gram gave it, where only the origin its
   * checkout names (`origin`) and the host its PR is on (`prHost`) vary.
   */
  const HOSTS = [
    {
      label: "a lookalike host",
      origin: "https://github.com.evil.example/acme/app.git",
      owned: false,
    },
    {
      label: "a hyphenated lookalike",
      origin: "https://github-com.example/acme/app.git",
      owned: false,
    },
    { label: "an scp lookalike", origin: "git@github.com.evil.example:acme/app.git", owned: false },
    {
      label: "an Enterprise origin for a GitHub PR",
      origin: "https://ghe.example.test/acme/app.git",
      owned: false,
    },
    {
      label: "a GitHub origin for an Enterprise PR",
      origin: "https://github.com/acme/app.git",
      prHost: "ghe.example.test",
      owned: false,
    },
    {
      label: "a neighbouring Enterprise host",
      origin: "https://other-ghe.example.test/acme/app.git",
      prHost: "ghe.example.test",
      owned: false,
    },
    { label: "GitHub's www alias", origin: "https://www.github.com/acme/app", owned: true },
    {
      label: "GitHub's ssh alias",
      origin: "ssh://git@ssh.github.com:443/acme/app.git",
      owned: true,
    },
    {
      label: "the Enterprise PR's own host",
      origin: "git@ghe.example.test:acme/app.git",
      prHost: "ghe.example.test",
      owned: true,
    },
  ] as const;

  for (const each of HOSTS) {
    it.effect.skipIf(!hasGit)(
      `${each.owned ? "arms" : "asks before arming"} a worker's own PR from ${each.label}`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          world.origin = each.origin;
          world.prHost = "prHost" in each ? each.prHost : undefined;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "hosted" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, "full");
              world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
              const tools = registry.forTransport(worker.thread.id, "worker");
              yield* tools
                .find((t) => t.descriptor.name === "pr_bind")!
                .run({ repo: "acme/app", number: 12 });
              const merge = tools.find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({})).toBe(each.owned);
              if (each.owned) {
                yield* merge.run({});
                expect(
                  (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
                ).toMatchObject({ allowedBy: "autonomy" });
                expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
                return;
              }
              const call = yield* Effect.forkScoped(merge.run({}).pipe(Effect.flip));
              const card = yield* waitReal(
                "the approval card",
                store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
              );
              if (card.kind !== "approval") throw new Error("not an approval");
              expect(card.autonomyNote).toBe(
                "full auto, PR ownership unverified: it is in another repository than the worktree Gram gave the worker",
              );
              yield* runtimes.respond(worker.thread.id, card.id, {
                kind: "approval",
                decision: "deny",
                scope: "once",
              });
              yield* Fiber.join(call);
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  /**
   * An armed merge of a worker's own PR whose checkout's origin turns into `to` before its launch
   * looks again, or during GitHub's fresh read; `prHost` is where the PR is.
   */
  const SWITCHES = [
    {
      label: "a lookalike host",
      from: "https://github.com/acme/app.git",
      to: "https://github.com.evil.example/acme/app.git",
    },
    {
      label: "an Enterprise origin for a GitHub PR",
      from: "https://github.com/acme/app.git",
      to: "https://ghe.example.test/acme/app.git",
    },
    {
      label: "a GitHub origin for an Enterprise PR",
      from: "https://ghe.example.test/acme/app.git",
      to: "https://github.com/acme/app.git",
      prHost: "ghe.example.test",
    },
    {
      label: "nothing, on the Enterprise PR's own host",
      from: "https://ghe.example.test/acme/app.git",
      to: "https://ghe.example.test/acme/app.git",
      prHost: "ghe.example.test",
    },
  ] as const;

  for (const each of SWITCHES)
    for (const when of ["before the launch", "during the fresh read"] as const) {
      const merges = each.from === each.to;
      it.effect.skipIf(!hasGit)(
        `an armed merge whose origin turns to ${each.label} ${when} ${merges ? "merges" : "doesn't launch"}`,
        () =>
          Effect.gen(function* () {
            const world = yield* makeWorld;
            world.origin = each.from;
            const prHost = "prHost" in each ? each.prHost : "github.com";
            world.prHost = prHost;
            yield* withServer(
              world,
              Effect.gen(function* () {
                const store = yield* ThreadStore;
                const registry = yield* AppToolRegistry;
                const { session, thread } = yield* openOrchestrator(world);
                const worker = yield* spawn(session, { feature: "switched" });
                yield* completeTurn(worker.session);
                yield* atAutonomy(thread, "full");
                world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
                const tools = registry.forTransport(worker.thread.id, "worker");
                yield* tools
                  .find((t) => t.descriptor.name === "pr_bind")!
                  .run({ repo: "acme/app", number: 12 });
                const publish = (approved: boolean) =>
                  store.getThread(worker.thread.id).pipe(
                    Effect.flatMap((t) =>
                      publishGit(world, t, {
                        pr: {
                          ...armedWorkerBadge(approved),
                          url: `https://${prHost}/acme/app/pull/12`,
                        },
                      }),
                    ),
                  );
                yield* publish(false);
                yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
                expect(
                  (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
                ).toMatchObject({ allowedBy: "autonomy" });
                let switched = false;
                if (when === "before the launch") {
                  world.origin = each.to;
                  switched = true;
                } else
                  world.freshPrRead = Effect.sync(() => {
                    world.freshPrRead = undefined;
                    world.origin = each.to;
                    switched = true;
                  });
                yield* publish(true);
                yield* waitReal(
                  "the switch",
                  Effect.sync(() => switched || undefined),
                );
                if (merges)
                  yield* waitReal(
                    "the merge",
                    Effect.sync(
                      () =>
                        world.ghCalls.some((c) => c[2] === "merge" && c[3] === "12") || undefined,
                    ),
                  );
                yield* settle;
                expect(world.ghCalls.filter((c) => c[2] === "merge")).toHaveLength(merges ? 1 : 0);
              }),
            );
          }).pipe(Effect.scoped),
      );
    }

  it.effect.skipIf(!hasGit)("tells an orchestrator how its worker can hold the branch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "release" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          world.prHeads.set(21, { headRefName: DEPLOY });
          const merge = registry
            .forTransport(thread.id, "orchestrator")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          const refused = yield* merge
            .run({ threadId: worker.thread.id, pr: 21 })
            .pipe(Effect.flip);
          expect(refused.message).toContain(
            `Have the worker check it out in the worktree Gram gave it (\`git fetch origin ${DEPLOY}\` then \`git switch ${DEPLOY}\`), then call merge_when_ready again`,
          );
          expect(yield* store.listRequests(thread.id)).toEqual([]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("still asks below full autonomy", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "release" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          yield* store.updateWorkspace(thread.workspaceId!, (state) => ({
            ...state,
            charter: { ...state.charter, autonomy: "publish" as const },
          }));
          world.prHeads.set(21, { headRefName: DEPLOY });
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          const call = yield* Effect.forkScoped(merge.run({ pr: 21 }).pipe(Effect.flip));
          const card = yield* waitReal(
            "the approval card",
            store.listRequests(worker.thread.id).pipe(Effect.map((all) => all[0])),
          );
          expect(card).toMatchObject({ displayName: "merge_when_ready" });
          yield* runtimes.respond(worker.thread.id, card.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          expect((yield* Fiber.join(call)).message).toContain("The user declined merge_when_ready");
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const state of ["MERGED", "CLOSED"] as const) {
    it.effect.skipIf(!hasGit)(`refuses arming a ${state.toLowerCase()} PR without a card`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "done" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, state });
            yield* runtimes.updateThread(worker.thread.id, (t) => ({
              ...t,
              boundPr: { repo: "acme/app", number: 12, monitor: false },
            }));
            const merge = registry
              .forTransport(worker.thread.id, "worker")
              .find((t) => t.descriptor.name === "merge_when_ready")!;
            const refused = yield* merge.run({}).pipe(Effect.flip);
            expect(refused.message).toBe(
              `acme/app#12 is ${state.toLowerCase()}, so there is nothing to merge; check it with pr_status. Nobody was asked.`,
            );
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }

  for (const autonomy of ["full", "publish"] as const) {
    it.effect.skipIf(!hasGit)(
      `refuses a change to a merged PR's intent without ownership or a card at ${autonomy}`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "merged" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, "full");
              if (autonomy === "publish")
                yield* store.updateWorkspace(thread.workspaceId!, (state) => ({
                  ...state,
                  charter: { ...state.charter, autonomy: "publish" as const },
                }));
              // The deploy PR, merged from a branch the worker never held, with its intent left.
              world.prHeads.set(21, { headRefName: DEPLOY, state: "MERGED" });
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                boundPr: {
                  repo: "acme/app",
                  number: 21,
                  monitor: false,
                  mergeWhenReady: {
                    method: "squash",
                    allowedBy: "user",
                    hold: "deploy window",
                    heldBy: "thread",
                    setAt: 0,
                  },
                },
              }));
              // Its badge says so; below full nothing else is read before refusing.
              yield* publishGit(world, yield* store.getThread(worker.thread.id), {
                pr: badge({
                  number: 21,
                  url: "https://github.com/acme/app/pull/21",
                  state: "MERGED",
                }),
              });
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              for (const input of [{ release: true }, { hold: "later" }, {}]) {
                const refused = yield* merge.run(input).pipe(Effect.flip);
                expect(refused.message).toBe(
                  "acme/app#21 is merged, so there is nothing to merge; check it with pr_status. Nobody was asked.",
                );
              }
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
              // Dropping it goes through, and needs nothing either.
              yield* merge.run({ enabled: false });
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  for (const autonomy of ["full", "supervised"] as const) {
    it.effect.skipIf(!hasGit)(
      `drops an intent on a merged PR without ownership or a card at ${autonomy}`,
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          yield* withServer(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const runtimes = yield* ThreadRuntimes;
              const registry = yield* AppToolRegistry;
              const { session, thread } = yield* openOrchestrator(world);
              const worker = yield* spawn(session, { feature: "merged" });
              yield* completeTurn(worker.session);
              yield* atAutonomy(thread, autonomy);
              // Merged by hand from a branch the worker never held.
              world.prHeads.set(21, { headRefName: DEPLOY, state: "MERGED" });
              yield* runtimes.updateThread(worker.thread.id, (t) => ({
                ...t,
                boundPr: {
                  repo: "acme/app",
                  number: 21,
                  monitor: false,
                  mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 0 },
                },
              }));
              const merge = registry
                .forTransport(worker.thread.id, "worker")
                .find((t) => t.descriptor.name === "merge_when_ready")!;
              expect(yield* merge.delegatedAtFullAutonomy!({ enabled: false })).toBe(true);
              expect(yield* merge.run({ enabled: false })).toMatchObject({
                mergeWhenReady: false,
              });
              expect(
                (yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady,
              ).toBeUndefined();
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("still asks before dropping another thread's intent", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mine" });
          const sibling = yield* spawn(session, { feature: "theirs" });
          yield* completeTurn(worker.session);
          yield* completeTurn(sibling.session);
          yield* atAutonomy(thread, "full");
          yield* runtimes.updateThread(sibling.thread.id, (t) => ({
            ...t,
            boundPr: {
              repo: "acme/app",
              number: 30,
              monitor: false,
              mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 0 },
            },
          }));
          const merge = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "merge_when_ready")!;
          expect(
            yield* merge.delegatedAtFullAutonomy!({ enabled: false, threadId: sibling.thread.id }),
          ).toBe(false);
        }),
      );
    }).pipe(Effect.scoped),
  );
});
