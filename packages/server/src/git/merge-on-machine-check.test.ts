// A thread placed on a joined machine: Gram's own check of its PR runs on that machine, through its
// host, and its result gates merge_when_ready as a check on this machine does.
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type HostCheckResult,
  HostFailed,
  HostId,
  HostUnavailable,
  type PrStatus,
  type ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import { Pr, Proc } from "@gram/git";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCheckRequest } from "../host/checks.ts";
import type { HostConnection } from "../host/protocol.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ServerConfig } from "../config.ts";
import { RuntimeTestLayer, TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import {
  checkSiteOf,
  type LocalCheck,
  LocalCheckRunner,
  LocalChecks,
  LocalChecksLive,
  MachineReattachMs,
} from "./local-checks.ts";
import { MergeFreezesNone } from "./merge-freezes.ts";
import { MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MACHINE = HostId.make("m-0123456789abcdef01234567");
/** The worker's checkout there, and the clone it was made from: folders this disk never has. */
const CHECKOUT = {
  kind: "worktree" as const,
  path: "/home/invented/gram-host/worktrees/widgets/feat-seven",
  repoRoot: "/home/invented/gram-host/repos/github.com/example/project",
  branch: "feat/seven",
  hostId: MACHINE,
};

const badge: PrStatus = {
  number: 7,
  state: "OPEN",
  url: "https://github.com/example/project/pull/7",
  title: "PR 7",
  isDraft: false,
  // CI hasn't finished: only Gram's own check can let the merge through.
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEAD,
  baseRefOid: BASE,
  baseRef: "main",
  headRef: "feat/seven",
  mergeState: "UNSTABLE",
};

const passed = (request: HostCheckRequest): HostCheckResult => ({
  tree: "c".repeat(40),
  mergedCommit: "d".repeat(40),
  ok: true,
  log: `checked ${request.head} on ${request.base}\n`,
  host: "cachyos",
});

/**
 * The joined machine `cachyos`, online while `online()` says so, its host answering each check
 * request as `answer` does. `checks: false` is a host from before it ran checks.
 */
const machine = (
  answer: (
    request: HostCheckRequest,
  ) => Effect.Effect<HostCheckResult, HostFailed | HostUnavailable>,
  options: { readonly online?: () => boolean; readonly checks?: boolean } = {},
) => {
  const asked: Array<HostCheckRequest> = [];
  const connection = {
    ...(options.checks === false
      ? {}
      : {
          checks: {
            run: (request: HostCheckRequest) =>
              Effect.suspend(() => {
                asked.push(request);
                return answer(request);
              }),
          },
        }),
    gone: () => false,
  } as unknown as HostConnection;
  const hosts = {
    machines: {
      get: (id: string) =>
        id === MACHINE ? { id: MACHINE, name: "cachyos", platform: "linux" } : undefined,
    },
    connection: (id: HostId) =>
      id === MACHINE && (options.online?.() ?? true)
        ? Effect.succeed(connection)
        : Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
  } as unknown as RemoteHostsShape;
  return { asked, layer: Layer.succeed(RemoteHosts, hosts) };
};

/** Arms the thread on `cachyos` to merge under solo, with a project check configured. */
const armed = (hosts: Layer.Layer<RemoteHosts>) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "gram-machine-check-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const merged: Array<ReadonlyArray<string>> = [];
    const localGit: Array<string> = [];
    const proc = Layer.succeed(Proc, {
      run: (bin, args, options) =>
        Effect.sync(() => {
          if (bin === "git") localGit.push(`${options?.cwd ?? ""} ${args.join(" ")}`);
          if (args[0] === "pr" && args[1] === "merge") merged.push([...args]);
          return {
            status: 0,
            stdout:
              args[0] === "pr" && args[1] === "view"
                ? JSON.stringify({
                    state: merged.length > 0 ? "MERGED" : "OPEN",
                    headRefOid: HEAD,
                  })
                : "",
            stderr: "",
            truncated: false,
          };
        }),
    });
    const provider = Layer.succeed(Pr, {
      status: () => Effect.succeed(badge),
    } as unknown as Pr["Service"]);
    const publisher = Layer.succeed(GitStatePublisher, {
      badgeFor: () => Effect.succeed(badge),
      stateFor: () => Effect.succeed(undefined),
      extraBadgesFor: () => Effect.succeed([]),
      watchPrs: () => Effect.void,
      watchedBadge: () => Effect.succeed(undefined),
      lookupPr: () => Effect.succeed(Option.none()),
      stateForThread: () => Effect.succeed(undefined),
      refresh: () => Effect.void,
      reconcile: () => Effect.void,
      checksRead: () => Effect.void,
      sweep: Effect.void,
      sync: Effect.void,
      hold: () => Effect.succeed(Effect.void),
      observe: () => Effect.void,
    });
    // Gram's own checks, the real ones: this machine's runner never runs a joined machine's.
    const checks = LocalChecksLive.pipe(
      Layer.provide(
        Layer.succeed(LocalCheckRunner, {
          run: () => Effect.die("a joined machine's check ran on this machine"),
        }),
      ),
      Layer.provide(hosts),
      Layer.provide(ServerConfig.layer({ ...TEST_CONFIG, dataDir: dir })),
    );
    const layer = MergeWhenReadyLive.pipe(
      Layer.provide(MergeFreezesNone),
      Layer.provideMerge(provider),
      Layer.provideMerge(publisher),
      Layer.provideMerge(checks),
      Layer.provideMerge(proc),
      Layer.provideMerge(GitRefresh.layer),
      Layer.provideMerge(RuntimeTestLayer),
      Layer.provideMerge(captureLogs({ printWarnings: true }).layer),
    );
    return { dir, merged, localGit, layer };
  });

/** The thread, moved onto `cachyos`, under solo with its PR bound and the merge armed. */
const placed = (dir: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const thread = yield* runtimes.create({
      projectRoot: dir,
      checkout: { kind: "main", path: dir },
    });
    yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
    const project = (yield* store.listProjects).find((p) => p.id === thread.projectId)!;
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
        proposerRole: "plain",
        scope: "project",
        approvedBy: "user",
        approvedAt: 1,
        changes: [],
        shown: [],
      },
      project.localCheckRevision!,
    );
    const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("on-machine");
    yield* store.putWorkspace({
      workspace: {
        id: workspaceId,
        name: "On a machine",
        projectIds: [thread.projectId],
        homeProjectId: thread.projectId,
        createdAt: 1,
      },
      charter: { ...DEFAULT_CHARTER, mergeReviewPolicy: "solo" },
    });
    const updated = yield* runtimes.updateThread(thread.id, (t) => ({
      ...t,
      checkout: CHECKOUT,
      workspaceId,
      boundPr: {
        repo: "example/project",
        number: 7,
        monitor: true,
        mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 1 },
      },
    }));
    return { thread: updated, site: checkSiteOf(updated.checkout, updated.checkout.path) };
  });

const MERGE_ARGS = [
  "pr",
  "merge",
  "7",
  "--squash",
  "--match-head-commit",
  HEAD,
  "--repo",
  "example/project",
];

describe("Gram's own check of a thread on a joined machine", () => {
  it.live("runs on its host, and its pass lets the merge through as a local one does", () =>
    Effect.gen(function* () {
      const host = machine((request) => Effect.succeed(passed(request)));
      const { dir, merged, localGit, layer } = yield* armed(host.layer);
      yield* Effect.gen(function* () {
        const { thread, site } = yield* placed(dir);
        const checks = yield* LocalChecks;
        expect(yield* checks.configuration(site, thread.projectId)).toMatchObject({
          config: { command: "invented-check" },
        });
        yield* (yield* MergeWhenReady).check(thread.id as ThreadId);
        yield* waitReal(
          "the merge",
          Effect.sync(() => merged.length > 0),
        );
        expect(merged).toEqual([MERGE_ARGS]);
        // Asked of the machine's host, in its checkout there, for the exact head and base.
        expect(host.asked).toEqual([
          {
            id: host.asked[0]!.id,
            path: CHECKOUT.path,
            repoRoot: CHECKOUT.repoRoot,
            head: HEAD,
            base: BASE,
            command: "invented-check",
            timeoutMs: 90 * 60_000,
          },
        ]);
        // Its record is the pass merge_when_ready and pr_status read, kept as the machine's.
        expect(yield* checks.lookup(site, HEAD, BASE, thread.projectId)).toMatchObject({
          status: "passed",
          head: HEAD,
          base: BASE,
          tree: "c".repeat(40),
          mergedCommit: "d".repeat(40),
          machine: MACHINE,
          host: "cachyos",
        });
        // Not this machine's: no folder of the joined machine's was asked of this disk's git.
        expect(yield* checks.lookup(dir, HEAD, BASE, thread.projectId)).toBeUndefined();
        expect(localGit.filter((call) => call.includes("/home/invented/"))).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live("a connection that drops mid-check asks again under the same id, and waits", () =>
    Effect.gen(function* () {
      let online = true;
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const host = machine(
        (request) =>
          Effect.suspend(() => {
            calls++;
            if (calls === 1) {
              // The connection goes while the check still runs there; it dials in again later.
              online = false;
              setTimeout(() => (online = true), 300);
              return Effect.fail(
                new HostUnavailable({
                  hostId: MACHINE,
                  message: "This machine's host isn't answering.",
                }),
              );
            }
            return Deferred.await(release).pipe(Effect.as(passed(request)));
          }),
        { online: () => online },
      );
      const { dir, merged, layer } = yield* armed(host.layer);
      yield* Effect.gen(function* () {
        const { thread, site } = yield* placed(dir);
        const checks = yield* LocalChecks;
        yield* (yield* MergeWhenReady).check(thread.id as ThreadId);
        yield* waitReal(
          "asked again once the machine is back",
          Effect.sync(() => host.asked.length === 2),
        );
        // The same run, not a second one; nothing passed while the answer was missing.
        expect(host.asked[1]!.id).toBe(host.asked[0]!.id);
        expect(yield* checks.lookup(site, HEAD, BASE, thread.projectId)).toMatchObject({
          status: "running",
        });
        expect(merged).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        yield* waitReal(
          "the merge",
          Effect.sync(() => merged.length > 0),
        );
        expect(merged).toEqual([MERGE_ARGS]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live("a machine that doesn't come back leaves the check unknown, never a pass", () =>
    Effect.gen(function* () {
      let online = true;
      const host = machine(
        () =>
          Effect.suspend(() => {
            online = false;
            return Effect.fail(
              new HostUnavailable({
                hostId: MACHINE,
                message: "This machine's host isn't answering.",
              }),
            );
          }),
        { online: () => online },
      );
      const { dir, merged, layer } = yield* armed(host.layer);
      yield* Effect.gen(function* () {
        const { thread, site } = yield* placed(dir);
        const checks = yield* LocalChecks;
        yield* (yield* MergeWhenReady).check(thread.id as ThreadId);
        const ended = yield* waitReal(
          "the check given up",
          checks
            .lookup(site, HEAD, BASE, thread.projectId)
            .pipe(Effect.map((check) => check?.status === "failed")),
        );
        expect(ended).toBe(true);
        const record = (yield* checks.lookup(site, HEAD, BASE, thread.projectId)) as LocalCheck;
        expect(record).toMatchObject({ status: "failed", failure: { kind: "stopped" } });
        expect(record.reason).toContain("how it ended is unknown");
        expect(merged).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.provideService(MachineReattachMs, 200));
    }).pipe(Effect.scoped),
  );

  it.live("a host from before checks reads as no local check on that machine", () =>
    Effect.gen(function* () {
      const host = machine(() => Effect.die("never asked"), { checks: false });
      const { dir, layer } = yield* armed(host.layer);
      yield* Effect.gen(function* () {
        const { thread, site } = yield* placed(dir);
        const found = yield* (yield* LocalChecks).configuration(site, thread.projectId);
        expect(found.config).toBeUndefined();
        expect(found.reason).toContain("no local check on cachyos");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live("a pass that doesn't name its merged tree and commit isn't one", () =>
    Effect.gen(function* () {
      const host = machine(() => Effect.succeed({ tree: null, ok: true, host: "cachyos" }));
      const { dir, merged, layer } = yield* armed(host.layer);
      yield* Effect.gen(function* () {
        const { thread, site } = yield* placed(dir);
        const checks = yield* LocalChecks;
        yield* (yield* MergeWhenReady).check(thread.id as ThreadId);
        yield* waitReal(
          "the pass refused",
          checks
            .lookup(site, HEAD, BASE, thread.projectId)
            .pipe(Effect.map((check) => check?.status === "failed")),
        );
        expect(yield* checks.lookup(site, HEAD, BASE, thread.projectId)).toMatchObject({
          status: "failed",
          failure: { kind: "unstartable" },
        });
        expect(merged).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live("a host's refusal is a failure it can act on, not a pass", () =>
    Effect.gen(function* () {
      const host = machine(() => Effect.fail(new HostFailed({ message: "no such checkout" })));
      const { dir, merged, layer } = yield* armed(host.layer);
      yield* Effect.gen(function* () {
        const { thread, site } = yield* placed(dir);
        const checks = yield* LocalChecks;
        yield* (yield* MergeWhenReady).check(thread.id as ThreadId);
        yield* waitReal(
          "the refusal recorded",
          checks
            .lookup(site, HEAD, BASE, thread.projectId)
            .pipe(Effect.map((check) => check?.status === "failed")),
        );
        expect(yield* checks.lookup(site, HEAD, BASE, thread.projectId)).toMatchObject({
          status: "failed",
          reason: "cachyos couldn't run it: no such checkout",
          failure: { kind: "unstartable" },
        });
        expect(merged).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
