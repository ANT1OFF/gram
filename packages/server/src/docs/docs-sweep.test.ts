import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SETTINGS,
  type DocMeta,
  type DocPr,
  type DocsArchivePolicy,
  type PrStatus,
  type Settings,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS } from "../zone-time.ts";
import {
  archiveDocsOlderThan,
  docSweepStep,
  markDocOpened,
  prStatesOf,
  sweepDocs,
} from "./docs-sweep.ts";
import { type DocAuthor, type DocLimits, makeDocs } from "./docs.ts";

const WS = "ws-sweep" as WorkspaceId;
const POLICY: DocsArchivePolicy = { prDays: 7, workerDays: 14, keep: 2000 };
const PR: DocPr = { repo: "acme/widgets", number: 42 };
const PR_URL = "https://github.com/acme/widgets/pull/42";

const doc = (fields: Partial<DocMeta> = {}): DocMeta => ({
  id: "plan-abc123" as DocMeta["id"],
  workspaceId: WS,
  title: "Plan",
  authorThreadId: "t-worker" as ThreadId,
  authorTitle: "Worker",
  createdAt: 0,
  updatedAt: 0,
  updatedBy: "agent",
  revision: 1,
  bytes: 1,
  excerpt: "",
  ...fields,
});

const days = (n: number) => n * DAY_MS;

describe("docSweepStep", () => {
  const now = days(100);
  const archivedWorker = { orchestrator: false, archivedAt: now - days(20) };

  it("archives a PR's doc 7 days after the sweep first saw the PR settled, and never while open", () => {
    const bound = doc({ pr: PR, updatedAt: now - days(30) });
    expect(docSweepStep(bound, archivedWorker, "settled", POLICY, now)).toEqual({
      kind: "markPrSettled",
    });
    const marked = { ...bound, prSettledAt: now - days(6) };
    expect(docSweepStep(marked, archivedWorker, "settled", POLICY, now)).toBeUndefined();
    expect(
      docSweepStep({ ...marked, prSettledAt: now - days(7) }, undefined, undefined, POLICY, now),
    ).toEqual({
      kind: "archive",
      reason: "pr-merged",
    });
    // Its worker archived long ago, but the PR is still open: it stays.
    expect(docSweepStep(bound, archivedWorker, "open", POLICY, now)).toBeUndefined();
    // No thread follows the PR any more: it goes as a worker's doc does.
    expect(docSweepStep(bound, archivedWorker, undefined, POLICY, now)).toEqual({
      kind: "archive",
      reason: "worker-archived",
    });
    expect(
      docSweepStep(
        { ...marked, prSettledAt: now - days(2) },
        undefined,
        undefined,
        { ...POLICY, prDays: 2 },
        now,
      ),
    ).toMatchObject({ kind: "archive" });
  });

  it("archives a worker's other docs 14 days after it was archived or closed, or its last save once it is gone", () => {
    const plain = doc({ updatedAt: now - days(30) });
    expect(docSweepStep(plain, { orchestrator: false }, undefined, POLICY, now)).toBeUndefined();
    expect(
      docSweepStep(
        plain,
        { orchestrator: false, archivedAt: now - days(13) },
        undefined,
        POLICY,
        now,
      ),
    ).toBeUndefined();
    expect(
      docSweepStep(
        plain,
        { orchestrator: false, archivedAt: now - days(14) },
        undefined,
        POLICY,
        now,
      ),
    ).toEqual({
      kind: "archive",
      reason: "worker-archived",
    });
    expect(docSweepStep(plain, undefined, undefined, POLICY, now)).toMatchObject({
      kind: "archive",
    });
    expect(
      docSweepStep(doc({ updatedAt: now - days(13) }), undefined, undefined, POLICY, now),
    ).toBeUndefined();
  });

  it("never archives the orchestrator's docs, or one the user opened or saved in the last 14 days", () => {
    const old = { updatedAt: now - days(60) };
    expect(
      docSweepStep(doc({ ...old, authorOrchestrator: true }), undefined, undefined, POLICY, now),
    ).toBeUndefined();
    expect(
      docSweepStep(
        doc(old),
        { orchestrator: true, archivedAt: now - days(60) },
        undefined,
        POLICY,
        now,
      ),
    ).toBeUndefined();
    expect(
      docSweepStep(doc({ ...old, userSeenAt: now - days(13) }), undefined, undefined, POLICY, now),
    ).toBeUndefined();
    expect(
      docSweepStep(
        doc({ updatedAt: now - days(13), updatedBy: "user" }),
        undefined,
        undefined,
        POLICY,
        now,
      ),
    ).toBeUndefined();
    expect(
      docSweepStep(doc({ ...old, userSeenAt: now - days(15) }), undefined, undefined, POLICY, now),
    ).toMatchObject({ kind: "archive" });
    // A PR seen settled is still marked while the user keeps it, so its days count from then.
    expect(
      docSweepStep(
        doc({ ...old, pr: PR, userSeenAt: now }),
        archivedWorker,
        "settled",
        POLICY,
        now,
      ),
    ).toEqual({ kind: "markPrSettled" });
  });
});

describe("prStatesOf", () => {
  it("counts a PR settled when any thread saw it merge or close, whatever an older badge says", () => {
    const states = prStatesOf(
      [
        { url: "https://github.com/ACME/Widgets/pull/42", state: "OPEN" },
        { url: "https://github.com/acme/widgets/pull/43", state: "CLOSED" },
        { url: "https://github.com/acme/widgets/pull/44", state: "OPEN" },
        { url: "not a url", state: "MERGED" },
      ],
      [PR_URL],
    );
    expect(Object.fromEntries(states)).toEqual({
      "acme/widgets#42": "settled",
      "acme/widgets#43": "settled",
      "acme/widgets#44": "open",
    });
  });
});

const worker = (n: number): DocAuthor => ({
  threadId: `t-worker-${n}` as ThreadId,
  title: `Worker ${n}`,
  orchestrator: false,
});
const ORCHESTRATOR: DocAuthor = {
  threadId: "t-orchestrator" as ThreadId,
  title: "Orchestrator",
  orchestrator: true,
};

const thread = (id: string, fields: Partial<Thread> = {}): Thread =>
  ({ id, title: id, role: "worker", parked: false, lastActivityAt: 0, ...fields }) as Thread;

const setup = (limits?: DocLimits) =>
  Effect.gen(function* () {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-docs-sweep-")));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    );
    const docs = makeDocs(join(dir, "docs"), () => Effect.void, undefined, limits);
    const world = {
      settings: DEFAULT_SETTINGS satisfies Settings,
      threads: [] as Thread[],
      closed: [] as Array<{ thread: Thread; closedAt: number }>,
      badges: new Map<string, Pick<PrStatus, "url" | "state">>(),
    };
    const store = {
      getSettings: Effect.sync(() => world.settings),
      listWorkspaces: Effect.succeed([{ workspace: { id: WS } }] as unknown as WorkspaceState[]),
      listThreads: Effect.sync(() => world.threads),
      listClosed: Effect.sync(() => world.closed),
    };
    const publisher = {
      badgeFor: (each: Thread) =>
        Effect.sync(() => world.badges.get(each.id) as PrStatus | undefined),
      extraBadgesFor: () => Effect.succeed([]),
    };
    const sweep = sweepDocs(docs, store, publisher);
    const publish = (title: string, author: DocAuthor, pr?: DocPr) =>
      docs
        .publish({ workspaceId: WS, author, title, content: `${title} text`, pr })
        .pipe(Effect.map(({ meta }) => meta.id));
    const active = () => docs.list(WS).pipe(Effect.map((list) => list.map((each) => each.id)));
    return { docs, world, sweep, store, publish, active };
  });

describe("sweepDocs", () => {
  it.effect(
    "archives a review doc 7 days after its PR merged, and a worker's notes 14 after it was archived",
    () =>
      Effect.gen(function* () {
        const { docs, world, sweep, publish, active } = yield* setup();
        yield* TestClock.setTime(days(1));
        const review = yield* publish("Review of #42", worker(1), PR);
        const notes = yield* publish("Notes", worker(2));
        const plan = yield* publish("Plan", ORCHESTRATOR);
        world.threads = [
          thread("t-worker-1", { boundPr: { repo: "acme/widgets", number: 42, monitor: false } }),
          thread("t-worker-2", { parked: true, parkedAt: days(2) }),
          thread("t-orchestrator", { role: "orchestrator" }),
        ];
        world.badges.set("t-worker-1", { url: PR_URL, state: "MERGED" });

        yield* TestClock.setTime(days(3));
        expect(yield* sweep).toEqual({ archived: 0, marked: 1 });
        // A mark writes no revision.
        expect((yield* docs.read(WS, review)).revision).toBe(1);

        yield* TestClock.setTime(days(10) - 1);
        expect((yield* sweep).archived).toBe(0);
        yield* TestClock.setTime(days(10));
        expect(yield* sweep).toEqual({ archived: 1, marked: 0 });
        expect(yield* active()).toEqual(expect.arrayContaining([notes, plan]));
        expect((yield* docs.read(WS, review)).archivedReason).toBe("pr-merged");

        yield* TestClock.setTime(days(16));
        expect((yield* sweep).archived).toBe(1);
        expect((yield* docs.read(WS, notes)).archivedReason).toBe("worker-archived");
        // The orchestrator's plan stays, however old.
        yield* TestClock.setTime(days(400));
        yield* sweep;
        expect(yield* active()).toEqual([plan]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps a doc the user opened, and takes the day counts from Settings", () =>
    Effect.gen(function* () {
      const { world, sweep, publish, active, docs } = yield* setup();
      const opened = yield* publish("Opened", worker(1));
      const other = yield* publish("Other", worker(1));
      world.threads = [thread("t-worker-1", { parked: true, parkedAt: 0 })];
      world.settings = { ...DEFAULT_SETTINGS, workspaces: { docsArchiveWorkerDays: 3 } };

      yield* TestClock.setTime(days(2));
      yield* markDocOpened(docs, WS, opened);
      expect((yield* docs.read(WS, opened)).revision).toBe(1);
      yield* TestClock.setTime(days(3));
      expect((yield* sweep).archived).toBe(1);
      expect(yield* active()).toEqual([opened]);
      expect((yield* docs.read(WS, other)).archivedAt).toBe(days(3));
      // Fourteen days after it was opened, it goes too.
      yield* TestClock.setTime(days(16));
      expect((yield* sweep).archived).toBe(1);
      expect(yield* active()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("archives nothing the user opened between the sweep's look and its archive", () =>
    Effect.gen(function* () {
      const { docs, publish } = yield* setup();
      const id = yield* publish("Notes", worker(1));
      yield* TestClock.setTime(days(30));
      const kept = yield* docs.archiveIfDue(WS, id, "worker-archived", () => false);
      expect(kept).toBeUndefined();
      expect((yield* docs.read(WS, id)).archivedAt).toBeUndefined();
      // The sweep may archive, but never restore or delete.
      yield* docs.archiveIfDue(WS, id, "worker-archived", () => true);
      expect((yield* Effect.flip(docs.restore(WS, id, "sweep")))._tag).toBe("InvalidState");
      expect((yield* Effect.flip(docs.remove(WS, id, "sweep")))._tag).toBe("InvalidState");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps as many archived docs as Settings says", () =>
    Effect.gen(function* () {
      let keep = 2;
      const { docs, publish } = yield* setup({ archiveKeep: Effect.sync(() => keep) });
      const ids = [];
      for (const title of ["A", "B", "C"]) {
        yield* TestClock.adjust("1 second");
        const id = yield* publish(title, worker(1));
        yield* docs.archive(WS, id, worker(1), "manual");
        ids.push(id);
      }
      expect((yield* docs.listArchived(WS)).map((each) => each.id)).toEqual([ids[2], ids[1]]);
      keep = 10;
      const d = yield* publish("D", worker(1));
      yield* docs.archive(WS, d, worker(1), "manual");
      expect(yield* docs.counts(WS)).toEqual({ active: 0, archived: 3 });
    }).pipe(Effect.scoped),
  );
});

describe("archiveDocsOlderThan", () => {
  it.effect("archives every doc neither saved nor opened since, the orchestrator's too", () =>
    Effect.gen(function* () {
      const { docs, store, publish, active } = yield* setup();
      const plan = yield* publish("Plan", ORCHESTRATOR);
      const notes = yield* publish("Notes", worker(1));
      yield* TestClock.setTime(days(5));
      const fresh = yield* publish("Fresh", worker(1));
      yield* markDocOpened(docs, WS, notes);
      yield* TestClock.setTime(days(10));
      expect(yield* archiveDocsOlderThan(docs, store, 7)).toBe(1);
      expect((yield* docs.read(WS, plan)).archivedReason).toBe("manual");
      expect((yield* active()).toSorted()).toEqual([fresh, notes].toSorted());
    }).pipe(Effect.scoped),
  );
});
