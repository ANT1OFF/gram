// A worker's PR under the solo merge review policy, for tests of merge_when_ready and local_check
// with Gram's own check: the world, the worker, its PR and what it was told.
import * as Effect from "effect/Effect";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import {
  atAutonomy,
  completeTurn,
  openOrchestrator,
  publishGit,
  spawn,
  waitReal,
  type World,
} from "../orchestration/test-harness.ts";
import { AppToolRegistry } from "./registry.ts";
import { badge } from "./pr-tools-kit.ts";

/**
 * A worker under solo policy with its PR bound, on a branch one commit ahead of `main`, while
 * `main` moved on by a commit of its own. `runner` is Gram's own check, run in place of
 * `bun run check:ci`.
 */
export const soloPr = (world: World, configured = true) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const registry = yield* AppToolRegistry;
    const { session, thread, workspaceId } = yield* openOrchestrator(world);
    const project = (yield* store.listProjects).find((p) => p.id === thread.projectId)!;
    if (configured)
      yield* store.updateProjectLocalCheckAudited(
        project.id,
        [
          {
            key: "project.localCheck.command",
            path: ["localCheck", "command"],
            before: undefined,
            after: "invented-check",
          },
        ],
        {
          at: 1,
          threadId: thread.id,
          proposerRole: "orchestrator",
          scope: "project",
          approvedBy: "user",
          approvedAt: 1,
          changes: [],
          shown: [],
        },
        project.localCheckRevision!,
      );
    const worker = yield* spawn(session, { feature: "local-check" });
    yield* completeTurn(worker.session);
    yield* atAutonomy(thread, "full");
    yield* store.updateWorkspace(workspaceId, (state) => ({
      ...state,
      charter: { ...state.charter, mergeReviewPolicy: "solo" },
    }));
    const tool = (name: string) =>
      registry.forTransport(worker.thread.id, "worker").find((t) => t.descriptor.name === name)!;
    yield* tool("pr_bind").run({ repo: "acme/app", number: 12 });
    const checkout = worker.thread.checkout.path;
    writeFileSync(join(checkout, "feature.txt"), "feature\n");
    run(checkout, "add", "feature.txt");
    run(checkout, "commit", "-q", "-m", "feature");
    const head = run(checkout, "rev-parse", "HEAD").trim();
    // Nothing outside the commit may reach the check: untracked, excluded or not.
    writeFileSync(join(checkout, "scratch.txt"), "uncommitted\n");
    const moveBase = (name: string) => {
      writeFileSync(join(world.repo, name), `${name}\n`);
      run(world.repo, "add", name);
      run(world.repo, "commit", "-q", "-m", name);
      return run(world.repo, "rev-parse", "HEAD").trim();
    };
    const publish = (
      base: string,
      at = head,
      checks: "passing" | "pending" | "failing" | "none" = "pending",
    ) =>
      store.getThread(worker.thread.id).pipe(
        Effect.flatMap((workerState) =>
          publishGit(world, workerState, {
            pr: badge({
              number: 12,
              url: "https://github.com/acme/app/pull/12",
              mergeState: "CLEAN",
              headRefOid: at,
              baseRefOid: base,
              checks,
            }),
          }),
        ),
      );
    /** A new commit on the branch, pushed: GitHub's head moves to it. */
    const pushNext = (name: string) => {
      writeFileSync(join(checkout, name), `${name}\n`);
      run(checkout, "add", name);
      run(checkout, "commit", "-q", "-m", name);
      const next = run(checkout, "rev-parse", "HEAD").trim();
      world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, headRefOid: next });
      return next;
    };
    /** `main` moved by an empty commit: the head merges onto it into the very same tree. */
    const moveBaseEmpty = (name: string) => {
      run(world.repo, "commit", "-q", "--allow-empty", "-m", name);
      return run(world.repo, "rev-parse", "HEAD").trim();
    };
    const ledgerPr = () =>
      registry
        .forTransport(thread.id, "orchestrator")
        .find((t) => t.descriptor.name === "list_workers")!
        .run({})
        .pipe(
          Effect.map(
            (ledger) =>
              (
                ledger as {
                  features: ReadonlyArray<{
                    workers: ReadonlyArray<{ threadId: string; pr?: Record<string, unknown> }>;
                  }>;
                }
              ).features
                .flatMap((feature) => feature.workers)
                .find((row) => row.threadId === worker.thread.id)?.pr,
          ),
        );
    world.prHeads.set(12, { headRefName: worker.thread.checkout.branch!, headRefOid: head });
    const merges = () =>
      world.ghCalls.filter((c) => c[2] === "merge" && !c.includes("--disable-auto"));
    const merged = waitReal(
      "the merge",
      store
        .getThread(worker.thread.id)
        .pipe(Effect.map((workerState) => workerState.boundPr?.mergeWhenReady === undefined)),
    );
    const told = (text: string) =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        return yield* waitReal(
          text,
          Effect.gen(function* () {
            // Sent as a turn, or steered into the one an earlier notice opened, or queued when
            // that turn can't take it.
            const agent = fake.sessions.findLast((s) => s.options.threadId === worker.thread.id);
            const queued = (yield* store.listQueue(worker.thread.id)).map((item) => item.input);
            return [...(agent?.sent ?? []), ...(agent?.steered ?? []), ...queued].some((input) =>
              input.text.includes(text),
            );
          }),
        );
      });
    return {
      workspaceId,
      thread: worker.thread,
      threadId: worker.thread.id,
      tool,
      head,
      moveBase,
      moveBaseEmpty,
      pushNext,
      publish,
      merges,
      merged,
      told,
      ledgerPr,
    };
  });

/** What a fake check saw of the worktree Gram made for it. */
export const sawOf = (dir: string) => ({
  parents: run(dir, "rev-parse", "HEAD^1", "HEAD^2").trim().split("\n"),
  files: ["feature.txt", "base.txt", "scratch.txt"].filter((file) => existsSync(join(dir, file))),
});
