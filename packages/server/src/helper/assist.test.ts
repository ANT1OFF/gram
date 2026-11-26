import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  RECAP_IDLE_MS,
  type ThreadId,
  type ThreadRecap,
  type WorkspaceId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import { Pr } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { GitStatePublisher, type GitStatePublisherShape } from "../git/publisher.ts";
import { ThreadVisibility } from "../git/visibility.ts";
import { notePrivacy, ReadingAs } from "../embedding/readable-by.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadWaits } from "../waits/service.ts";
import { ThreadAssist, ThreadAssistLive } from "./assist.ts";
import { HelperScheduler, type HelperJob, type HelperSchedulerShape } from "./scheduler.ts";
import type { WaitOutput } from "./wait.ts";

const answer: ThreadRecap = {
  recap: "You asked to fix the flake and the agent fixed it.",
  next: "Push the fix",
  replies: [],
};

/** Every job the real `ThreadAssistLive` hands the scheduler, with the prompt it built. */
const jobs: Array<{ readonly job: HelperJob<unknown, unknown>; readonly prompt: string }> = [];

/** The replies the recap answers with. */
const replies: { current: ReadonlyArray<string> } = { current: [] };

/** What the next job does while the helper "thinks", when a test sets it; taken by that job. */
const meanwhile: { current: Effect.Effect<unknown> | undefined } = { current: undefined };

/** What the helper answers a Waiting on you job, from the prompt it was given. */
const waitAnswer: { current: (prompt: string) => WaitOutput } = {
  current: () => ({ resolve: [] }),
};

const scheduler: HelperSchedulerShape = {
  schedule: <A, I>(job: HelperJob<A, I>) =>
    Effect.gen(function* () {
      jobs.push({ job: job, prompt: yield* job.prompt });
      const during = meanwhile.current;
      meanwhile.current = undefined;
      if (during !== undefined) yield* during;
      const value =
        job.kind === "recap"
          ? { ...answer, replies: replies.current }
          : job.kind === "wait"
            ? waitAnswer.current(jobs.at(-1)!.prompt)
            : answer;
      return { _tag: "Done", value: value as A, cached: false } as const;
    }),
  latest: () => Effect.succeed(Option.none()),
  recordEvent: () => Effect.void,
  presence: () => Effect.void,
  status: Effect.die("not used"),
};

// Only what the recap reads of the git publisher; the checkout here isn't a repository.
const publisher = {
  stateForThread: () => Effect.succeed(undefined),
} as unknown as GitStatePublisherShape;

// The helpers only peek at check names some other caller read; none here.
const pr = { seenChecks: () => Effect.succeed(undefined) } as unknown as Pr["Service"];

const AssistTestLayer = ThreadAssistLive.pipe(
  Layer.provideMerge(Layer.succeed(HelperScheduler, scheduler)),
  Layer.provideMerge(Layer.succeed(Pr, pr)),
  Layer.provideMerge(Layer.succeed(GitStatePublisher, publisher)),
  Layer.provideMerge(ThreadVisibility.layer),
  Layer.provideMerge(RuntimeTestLayer),
);

describe("ThreadAssistLive", () => {
  it.effect("puts the thread's stored plan in the recap, and a plan edit makes it again", () =>
    Effect.gen(function* () {
      jobs.length = 0;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const plans = yield* ThreadPlans;
      const assist = yield* ThreadAssist;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "fix the flake" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.completeTurn("fixed");
      yield* waitFor(
        "the turn's end",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
      );
      yield* plans.edit(thread.id, {
        goal: "Make the retry test deterministic",
        steps: [
          { text: "Reproduce the flake", status: "done" },
          { text: "Push the fix", status: "todo" },
        ],
      });
      yield* TestClock.adjust(Duration.millis(RECAP_IDLE_MS + 1));

      expect((yield* assist.recap(thread.id))?.recap.recap).toBe(answer.recap);
      const first = jobs.at(-1)!;
      expect(first.job.kind).toBe("recap");
      expect(first.prompt).toContain(
        '<plan>{"goal":"Make the retry test deterministic","steps":[{"text":"Reproduce the flake","status":"done"},{"text":"Push the fix","status":"todo"}]}</plan>',
      );

      // Editing the plan alone, with nothing new in the conversation, changes what the recap is made of.
      yield* plans.edit(thread.id, {
        goal: "Make the retry test deterministic",
        steps: [
          { text: "Reproduce the flake", status: "done" },
          { text: "Push the fix", status: "done" },
        ],
      });
      yield* assist.recap(thread.id);
      const second = jobs.at(-1)!;
      expect(second.job.basis).not.toBe(first.job.basis);
      expect(second.prompt).toContain('{"text":"Push the fix","status":"done"}');

      // Edited while the recap is made: its replies answer the plan it read, so they don't stand.
      meanwhile.current = plans.edit(thread.id, {
        goal: "Wait for the security review",
        steps: [],
      });
      replies.current = ["Push the fix now"];
      const stale = yield* assist
        .recap(thread.id)
        .pipe(Effect.ensuring(Effect.sync(() => (replies.current = []))));
      expect(stale?.recap.replies).toEqual([]);
    }).pipe(Effect.provide(AssistTestLayer)),
  );

  it.effect("resolves the agent's item when the user says sent, and suggests none of its own", () =>
    Effect.gen(function* () {
      jobs.length = 0;
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const waits = yield* ThreadWaits;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "Draft a Teams message to Kari about the fix" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* session.completeTurn("Here is the draft to send:\n\n> Hi Kari, the fix is out.");
      yield* waitFor(
        "the turn's end",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
      );
      const waitJobs = () => jobs.filter((j) => j.job.kind === "wait");
      // A reply with a deliverable in it adds nothing: only the agent adds items.
      expect(yield* waits.open(thread.id)).toEqual([]);
      expect(waitJobs()).toHaveLength(0);

      const { item } = yield* waits.put(
        thread.id,
        { kind: "draft", title: "Teams message to Kari", copy: "Hi Kari, the fix is out." },
        "agent",
      );
      waitAnswer.current = (prompt) => ({ resolve: prompt.includes(item.id) ? [item.id] : [] });
      yield* runtimes.send(thread.id, { text: "sent" });
      yield* waitFor(
        "the resolve",
        Effect.map(waits.open(thread.id), (open) => open.length === 0),
      );
      expect(yield* waits.helperResolved(thread.id)).toMatchObject([
        { id: item.id, resolvedBy: "helper" },
      ]);
      expect(waitJobs()).toHaveLength(1);
      expect(waitJobs()[0]?.job.lane).toBe("background");
      const second = yield* waitFor(
        "the second send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 2 && s)),
      );
      yield* second.completeTurn("Noted.");
      yield* waitFor(
        "the turn's end",
        runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")),
      );
      // The turn's end asks nothing more.
      expect(waitJobs()).toHaveLength(1);
    }).pipe(Effect.provide(AssistTestLayer)),
  );

  it.effect("offers the palette helper only workspaces the caller may see", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const project = yield* store.ensureProject({ root: "/synthetic/palette", name: "palette" });
      for (const [id, name] of [
        ["w-palette-open", "shared-platform"],
        ["w-palette-private", "ada-secret-plans"],
      ] as const)
        yield* store.putWorkspace({
          workspace: {
            id: id as WorkspaceId,
            name,
            projectIds: [project.id],
            homeProjectId: project.id,
            createdAt: 0,
          },
          charter: DEFAULT_CHARTER,
        });
      notePrivacy({
        id: "t-palette-ada" as ThreadId,
        readableBy: "ada",
        workspaceId: "w-palette-private",
      });
      const assist = yield* ThreadAssist;
      const before = jobs.length;
      yield* assist
        .paletteFilters("t-palette" as ThreadId, "show the secret plans workspace")
        .pipe(Effect.provideService(ReadingAs, { subject: "bob" }));
      const prompt = jobs
        .slice(before)
        .map((entry) => entry.prompt)
        .join("\n");
      expect(prompt).toContain("shared-platform");
      expect(prompt).not.toContain("ada-secret-plans");
      expect(prompt).not.toContain("w-palette-private");
    }).pipe(Effect.provide(AssistTestLayer)),
  );
});
