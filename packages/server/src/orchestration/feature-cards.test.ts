import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  prBadge,
  publishGit,
  settle,
  spawn,
  waitReal,
  withServer,
} from "./test-harness.ts";

// Live feature cards on the server: built from the ledger, versioned, persisted and pushed.

describe("feature cards", () => {
  it.effect("version on change, keep on no change, and survive a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const first = yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "mail-trigger", title: "Queue worker" });
          yield* completeTurn(worker.session);
          yield* settle;

          const one = yield* orchestration.featureCards(workspaceId);
          expect(one.cards).toHaveLength(1);
          expect(one.cards[0]).toMatchObject({
            feature: "mail-trigger",
            version: 1,
            createdAt: worker.thread.createdAt,
            workers: [{ threadId: worker.thread.id, title: "Queue worker", project: "shop" }],
          });
          // Asked again with nothing new, it is the same card.
          expect((yield* orchestration.featureCards(workspaceId)).cards).toEqual(one.cards);

          yield* publishGit(world, worker.thread, { pr: prBadge({ checks: "failing" }) });
          const two = yield* orchestration.featureCards(workspaceId);
          expect(two.cards).toHaveLength(1);
          expect(two.cards[0]).toMatchObject({
            version: 2,
            station: "checks",
            createdAt: one.cards[0]!.createdAt,
            workers: [
              {
                now: "checks failing",
                prs: [{ repo: "acme/shop", number: 12, checks: "failing", state: "open" }],
              },
            ],
          });
          return { workspaceId, cards: two.cards };
        }),
      );

      // A restart reads the same cards back: same versions, nothing bumped by reading them.
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          expect(yield* store.listFeatureCards(first.workspaceId)).toEqual(first.cards);
          const orchestration = yield* Orchestration;
          const after = yield* orchestration.featureCards(first.workspaceId);
          expect(after.cards.map((card) => card.version)).toEqual([2]);
          expect(after.cards[0]!.feature).toBe("mail-trigger");
        }),
      );
    }),
  );

  it.effect("pushes a newer card to a watcher when the ledger moves", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "rate-headers", title: "Rate limit" });
          yield* completeTurn(worker.session);
          yield* settle;
          const seen: Array<ReadonlyArray<number>> = [];
          yield* orchestration.watchFeatureCards(workspaceId).pipe(
            Stream.runForEach((cards) =>
              Effect.sync(() => void seen.push(cards.cards.map((card) => card.version))),
            ),
            Effect.forkScoped,
          );
          yield* waitReal(
            "the first cards",
            Effect.sync(() => seen.length === 1),
          );
          yield* publishGit(world, worker.thread, {
            pr: prBadge({ state: "MERGED", checks: "passing" }),
          });
          yield* TestClock.adjust("300 millis");
          yield* waitReal(
            "the newer card",
            Effect.sync(() => seen.length === 2),
          );
          // A move that changes nothing on the card sends nothing.
          yield* publishGit(world, worker.thread, {
            pr: prBadge({ state: "MERGED", checks: "passing" }),
          });
          yield* TestClock.adjust("300 millis");
          yield* settle;
          expect(seen).toEqual([[1], [2]]);
          const [card] = (yield* orchestration.featureCards(workspaceId)).cards;
          expect(card).toMatchObject({ station: "merged", workers: [{ now: "merged as #12" }] });
        }),
      );
    }),
  );

  it.effect("puts a helper summary only on the version it was written for", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "paging", title: "Paging" });
          yield* completeTurn(worker.session);
          yield* settle;
          const [v1] = (yield* orchestration.featureCards(workspaceId)).cards;
          expect(v1!.version).toBe(1);
          expect(
            yield* store.putFeatureCardSummary(workspaceId, "paging", {
              text: "Early.",
              version: 1,
            }),
          ).toBe(true);
          expect((yield* store.listFeatureCards(workspaceId))[0]?.summary).toEqual({
            text: "Early.",
            version: 1,
          });
          yield* publishGit(world, worker.thread, { pr: prBadge({ checks: "pending" }) });
          const [v2] = (yield* orchestration.featureCards(workspaceId)).cards;
          expect(v2).toMatchObject({ version: 2, summary: { text: "Early.", version: 1 } });
          // Written for version 1 after the card moved on: it doesn't land.
          expect(
            yield* store.putFeatureCardSummary(workspaceId, "paging", {
              text: "Late.",
              version: 1,
            }),
          ).toBe(false);
          expect((yield* store.listFeatureCards(workspaceId))[0]?.summary?.text).toBe("Early.");
        }),
      );
    }),
  );
});
