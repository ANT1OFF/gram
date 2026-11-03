// Condition wakes on an upstream release (`releasePublished`) and on an installed version changing
// (`versionChanged`): each fires once, a release only once it is old enough and not a prerelease,
// a registry that can't be read neither fires nor throws and is asked less and less often, and a
// Gram update is seen at the start after it, through the plain thread's wake store.
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { WakeConditions } from "../wakes/conditions.ts";
import { ThreadWakes } from "../wakes/thread-wakes.ts";
import type { UpstreamRelease } from "../wakes/upstream-releases.ts";
import { allSent, inServer, sentCount } from "./service-kit.ts";
import {
  completeTurn,
  makeWorld,
  openProject,
  settle,
  waitSent,
  type World,
  withServer,
} from "./test-harness.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A plain thread at rest, with the session its wakes are sent to. */
const openPlain = (world: World, title: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title,
      input: { text: "hello" },
    });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session };
  });

/** A release of `@openai/codex`'s, published at `publishedAt`. */
const release = (version: string, publishedAt: number, prerelease = false): UpstreamRelease => ({
  version,
  publishedAt,
  url: `https://www.npmjs.com/package/@openai/codex/v/${version}`,
  prerelease,
});

const readsOf = (world: World, key: string) =>
  world.releaseReads.filter((each) => each === key).length;

describe.skipIf(!hasGit)("release and version wakes", () => {
  it.effect(
    "a release fires once it is old enough, skipping prereleases; one already due is refused",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          const wakes = yield* ThreadWakes;
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "Bump codex");
          const now = yield* Clock.currentTimeMillis;
          world.releases.set("npm:@openai/codex", [
            release("0.166.0", now - 30 * DAY),
            // Older than seven days and newer, but a prerelease.
            release("0.167.0-alpha.1", now - 10 * DAY, true),
            // Newer, but a day old.
            release("0.167.0", now - DAY),
          ]);

          // With prereleases and no age, 0.167.0 is due already.
          const due = yield* session
            .callTool("schedule_wake", {
              condition: {
                kind: "releasePublished",
                source: "npm",
                name: "@openai/codex",
                after: "0.166.0",
                minAgeDays: 0,
                includePrerelease: true,
              },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(due.message).toContain("@openai/codex has 0.167.0 already");

          const set = yield* session.callTool("schedule_wake", {
            condition: {
              kind: "releasePublished",
              source: "npm",
              name: "@openai/codex",
              after: "v0.166.0",
            },
            note: "bump codex",
          });
          expect(set).toMatchObject({
            condition: { after: "0.166.0", minAgeDays: 7 },
            when: "@openai/codex on npm has a release newer than 0.166.0, at least 7 days old",
          });

          // Five days on, 0.167.0 is six days old: nothing.
          yield* TestClock.adjust(5 * DAY);
          yield* conditions.sweep("releasePublished");
          yield* settle;
          expect(yield* allSent(thread.id)).toHaveLength(1);

          // Past seven days, the next hourly look fires, from what it read, without the prerelease.
          yield* TestClock.adjust(DAY + HOUR);
          // Six days on, the thread's session has closed: the wake opens a new one.
          const sent = yield* sentCount(thread.id, 2);
          const text = sent[1] ?? "";
          expect(text).toContain(
            "for when @openai/codex on npm has a release newer than 0.166.0, at least 7 days old fired.",
          );
          expect(text).toContain(
            [
              "```wake-event",
              "condition: releasePublished",
              "source: npm",
              "name: @openai/codex",
              "version: 0.167.0",
              `published: ${new Date(now - DAY).toISOString()}`,
              "url: https://www.npmjs.com/package/@openai/codex/v/0.167.0",
              "after: 0.166.0",
              "```",
            ].join("\n"),
          );
          yield* settle;
          expect((yield* wakes.list).wakes).toEqual([]);

          // Once: a later release wakes nobody.
          world.releases.set("npm:@openai/codex", [release("0.168.0", now - 30 * DAY)]);
          yield* TestClock.adjust(7 * HOUR);
          yield* conditions.sweep("releasePublished");
          yield* settle;
          expect(yield* allSent(thread.id)).toHaveLength(2);
        }),
      ),
  );

  it.effect(
    "an unreadable registry neither fires nor throws, is asked less often, and takes the baseline once it reads",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          const wakes = yield* ThreadWakes;
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "Watch gh");
          const key = "github:cli/cli";
          world.releases.set("npm:nope", null);
          const missing = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "releasePublished", source: "npm", name: "nope" },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(missing.message).toContain("npm has no nope");
          const fraction = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "releasePublished", source: "npm", name: "nope", minAgeDays: 1.5 },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(fraction.message).toContain("whole number of days");
          const traversal = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "releasePublished", source: "github", name: "acme/.." },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(traversal.message).toContain("Name a GitHub repo as owner/repo");

          // GitHub can't be read: set anyway, with no baseline yet.
          const set = yield* session.callTool("schedule_wake", {
            condition: {
              kind: "releasePublished",
              source: "github",
              name: "cli/cli",
              minAgeDays: 0,
            },
            note: "update gh",
          });
          expect(set).toMatchObject({ when: "cli/cli on GitHub has a new release" });
          expect(readsOf(world, key)).toBe(1);

          // Backed off: not again for twelve hours, then a day.
          yield* conditions.sweep("releasePublished");
          yield* TestClock.adjust(11 * HOUR);
          yield* settle;
          expect(readsOf(world, key)).toBe(1);
          yield* TestClock.adjust(2 * HOUR);
          yield* settle;
          expect(readsOf(world, key)).toBe(2);
          yield* TestClock.adjust(22 * HOUR);
          yield* settle;
          expect(readsOf(world, key)).toBe(2);
          expect(yield* allSent(thread.id)).toHaveLength(1);
          expect((yield* wakes.list).wakes).toHaveLength(1);

          // It reads again: the latest is the baseline, not news.
          const now = yield* Clock.currentTimeMillis;
          world.releases.set(key, [release("2.80.0", now - 3 * DAY)]);
          yield* TestClock.adjust(2 * HOUR);
          yield* settle;
          expect(readsOf(world, key)).toBe(3);
          expect((yield* wakes.list).wakes[0]?.conditionState?.seen).toEqual({ after: "2.80.0" });
          expect(yield* allSent(thread.id)).toHaveLength(1);

          // Read every six hours from then; a new release fires.
          world.releases.set(key, [release("2.80.0", now - 3 * DAY), release("2.81.0", now)]);
          yield* TestClock.adjust(4 * HOUR);
          yield* settle;
          expect(readsOf(world, key)).toBe(3);
          yield* TestClock.adjust(HOUR + 1);
          const sent = yield* sentCount(thread.id, 2);
          expect(sent[1]).toContain("version: 2.81.0");
          expect(sent[1]).toContain("after: 2.80.0");
        }),
      ),
  );

  it.effect("a CLI's version change fires once, when a launch check sees it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        yield* openProject(world);
        const { thread, session } = yield* openPlain(world, "Codex moved");
        world.installed.set("codex", "0.166.0");

        const stale = yield* session
          .callTool("schedule_wake", {
            condition: { kind: "versionChanged", target: "codex", from: "0.150.0" },
            note: "x",
          })
          .pipe(Effect.flip);
        expect(stale.message).toContain("Codex is 0.166.0 already, not 0.150.0");
        const none = yield* session
          .callTool("schedule_wake", {
            condition: { kind: "versionChanged", target: "gh" },
            note: "x",
          })
          .pipe(Effect.flip);
        expect(none.message).toContain("found no gh version");

        const set = yield* session.callTool("schedule_wake", {
          condition: { kind: "versionChanged", target: "codex" },
          note: "rerun the smoke test",
        });
        expect(set).toMatchObject({
          condition: { from: "0.166.0" },
          when: "the installed Codex changes from 0.166.0",
        });

        world.installed.set("codex", "0.167.0");
        yield* PubSub.publish(world.installedChanged, undefined);
        const woken = yield* waitSent(thread.id, 2);
        expect(woken.sent[1]?.text).toContain(
          "```wake-event\ncondition: versionChanged\ntarget: codex\nversion: 0.167.0\nprevious: 0.166.0\n```",
        );
        yield* PubSub.publish(world.installedChanged, undefined);
        yield* settle;
        expect(woken.sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("a Gram update is seen at the start after it, through a restart", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.installed.set("gram", "1.5.0");
      const waiter = yield* withServer(
        world,
        Effect.gen(function* () {
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "After the update");
          const set = yield* session.callTool("schedule_wake", {
            condition: { kind: "versionChanged", target: "gram" },
            note: "check the new build",
          });
          expect(set).toMatchObject({ when: "Gram is updated from 1.5.0" });
          // No update yet: a look keeps waiting.
          yield* (yield* WakeConditions).sweep("versionChanged");
          yield* settle;
          expect(yield* allSent(thread.id)).toHaveLength(1);
          return thread.id;
        }),
      );
      world.installed.set("gram", "1.6.0");
      yield* withServer(
        world,
        Effect.gen(function* () {
          yield* settle;
          yield* TestClock.adjust("11 seconds");
          const woken = yield* waitSent(waiter, 1);
          expect(woken.sent[0]?.text).toContain("for when Gram is updated from 1.5.0 fired.");
          expect(woken.sent[0]?.text).toContain("target: gram\nversion: 1.6.0\nprevious: 1.5.0");
          expect((yield* (yield* ThreadWakes).list).wakes).toEqual([]);
        }),
      );
    }),
  );
});
