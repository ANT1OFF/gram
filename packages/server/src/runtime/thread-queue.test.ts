import { describe, expect, it } from "@effect/vitest";
import {
  fenceThreadMessage,
  InvalidState,
  NotFound,
  type QueueItemId,
  type ReviewNotice,
  serializeReviewNotice,
  type ServerEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "./fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes, type JoinQueued } from "./thread-runtimes.ts";

/** An input another thread sent, as `send_message` makes one. */
const from = (sender: string, text: string) => ({
  text,
  origin: { threadId: sender as ThreadId, title: sender, depth: 1 },
});

/** Input with no sender, and the test `joinsWith` uses to find its kind. */
const answer = (text: string) => ({ text: `answer ${text}` });
const isAnswer = (queued: { readonly text: string }) => queued.text.startsWith("answer");

const joinTexts: JoinQueued = (queued, next) => ({
  ...queued.input,
  text: `${queued.input.text}+${next.text}`,
});

/** Joins with how many messages the item held, to check the runtime's count. */
const counted: JoinQueued = (queued, next) => ({
  ...queued.input,
  text: `${queued.input.text}+${next.text}@${queued.messages}`,
});

/** A review monitor's notice for round `round` of PR `number`, as babysit sends one. */
const notice = (round: number, number = 7) => {
  const data: ReviewNotice = {
    kind: "review",
    number,
    round,
    blockers: [],
    suggestions: [],
    ciFailed: [],
  };
  return { text: serializeReviewNotice(data), notice: data };
};

/** Collects every server event published from now on. */
const recordEvents = Effect.gen(function* () {
  const hub = yield* EventHub;
  const events: Array<ServerEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(
      hub.serverEvents(Effect.succeed<ServerEvent>({ type: "threads.snapshot", threads: [] })),
      (event) => Effect.sync(() => void events.push(event)),
    ),
  );
  yield* waitFor(
    "the event subscription",
    Effect.sync(() => events.length > 0),
  );
  return events;
});

const queueTexts = (events: ReadonlyArray<ServerEvent>, threadId: ThreadId) =>
  events.flatMap((e) =>
    e.type === "thread.queue" && e.threadId === threadId ? [e.queue.map((q) => q.input.text)] : [],
  );

/** The text of each user message in the thread's stored feed, in order. */
const userTexts = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listMessages(threadId))
      .filter((m) => m.role === "user")
      .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
  });

const statusOf = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

const create = (text: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* runtimes.create({
      projectRoot: "/work/repo",
      checkout: { kind: "main", path: "/work/repo" },
      input: { text },
    });
  });

describe("ThreadRuntimes sends with nothing running", () => {
  it.effect(
    "puts the message in the feed at once while the session opens, never in the queue",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const events = yield* recordEvents;
        // As `claude` takes a second or two to start; the test clock holds it until it moves.
        yield* fake.setOpenDelay("1 second");
        const thread = yield* create("one");
        expect(yield* runtimes.status(thread.id)).toBe("starting");
        expect(yield* userTexts(thread.id)).toEqual(["one"]);
        expect((yield* runtimes.snapshot)[0]?.queue).toEqual([]);

        yield* TestClock.adjust("1 second");
        const first = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        expect(first.sent.map((i) => i.text)).toEqual(["one"]);
        yield* first.completeTurn();
        yield* statusOf(thread.id, "idle");

        // Evicted, the thread is cold, and the next send opens a session the same way.
        yield* TestClock.adjust("15 minutes");
        yield* statusOf(thread.id, "cold");
        expect(yield* runtimes.send(thread.id, { text: "again" })).toEqual({ queued: false });
        expect(yield* userTexts(thread.id)).toEqual(["one", "again"]);
        yield* TestClock.adjust("1 second");
        const resumed = yield* waitFor(
          "the resumed send",
          Effect.sync(() => fake.sessions[1]?.sent.length === 1 && fake.sessions[1]),
        );
        expect(resumed.sent.map((i) => i.text)).toEqual(["again"]);
        yield* statusOf(thread.id, "running");

        // Each went out as the message the feed already showed, and nothing ever showed as queued.
        expect(yield* userTexts(thread.id)).toEqual(["one", "again"]);
        expect(queueTexts(events, thread.id).filter((queue) => queue.length > 0)).toEqual([]);
        // Straight from starting to running: no idle between them for a queue to wait on.
        const statuses = events.flatMap((e) =>
          e.type === "thread.status" && e.threadId === thread.id ? [e.status] : [],
        );
        expect(statuses.slice(-2)).toEqual(["starting", "running"]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues a send behind the one the opening session is to carry", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setOpenDelay("1 second");
      const thread = yield* create("one");
      expect(yield* runtimes.send(thread.id, { text: "two" })).toEqual({ queued: true });
      expect((yield* runtimes.snapshot)[0]?.queue.map((q) => q.input.text)).toEqual(["two"]);

      yield* TestClock.adjust("1 second");
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one"]);
      yield* session.completeTurn();
      yield* waitFor(
        "the queued send",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one", "two"]);
      expect(yield* userTexts(thread.id)).toEqual(["one", "two"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues the send when the agent can't start, taking its message out of the feed", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setUnavailable("claude is not installed");
      const thread = yield* create("one");
      yield* statusOf(thread.id, "error");
      // Unsent, it waits where the user can send it again or take it back, and only there.
      const [failed] = yield* runtimes.snapshot;
      expect(failed?.queue.map((q) => q.input.text)).toEqual(["one"]);
      expect(yield* userTexts(thread.id)).toEqual([]);

      yield* fake.setUnavailable(undefined);
      yield* runtimes.steerQueued(thread.id, failed!.queue[0]!.id);
      const session = yield* waitFor(
        "the retried send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one"]);
      expect((yield* runtimes.snapshot)[0]?.queue).toEqual([]);
      expect(yield* userTexts(thread.id)).toEqual(["one"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "keeps a monitor's notice to a cold thread in the queue, where it can be taken back",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* create("one");
        const first = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        yield* first.completeTurn();
        yield* statusOf(thread.id, "idle");
        yield* TestClock.adjust("15 minutes");
        yield* statusOf(thread.id, "cold");

        yield* fake.setOpenDelay("1 second");
        yield* runtimes.sendNotice(thread.id, "review:7", notice(1));
        expect((yield* runtimes.snapshot)[0]?.queue.map((q) => q.input.notice)).toHaveLength(1);
        // The monitor turned off while the agent was starting: its notice goes with it.
        yield* runtimes.dropNotices(thread.id, (key) => key.startsWith("review:"));
        expect((yield* runtimes.snapshot)[0]?.queue).toEqual([]);
        yield* TestClock.adjust("1 second");
        yield* statusOf(thread.id, "idle");
        expect(fake.sessions[1]?.sent).toEqual([]);
        expect(yield* userTexts(thread.id)).toEqual(["one"]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues a send while a steered turn continues, and sends it when the turn ends", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* create("one");
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* statusOf(thread.id, "running");
      yield* runtimes.steer(thread.id, { text: "also this" });
      // The Claude adapter holds the turn open across the steer's continuation, so the
      // runtime sees a turn still running, and a send waits for it.
      yield* session.emit({ type: "status", status: "idle" });
      expect(yield* runtimes.status(thread.id)).toBe("running");
      expect(yield* runtimes.send(thread.id, { text: "next" })).toEqual({ queued: true });
      yield* session.completeTurn();
      yield* waitFor(
        "the queued send",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.steered.map((i) => i.text)).toEqual(["also this"]);
      expect(session.sent.map((i) => i.text)).toEqual(["one", "next"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("ThreadRuntimes queue", () => {
  it.effect("publishes the queue once as an item leaves it for the agent, never again after", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const events = yield* recordEvents;
      const thread = yield* create("one");
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* statusOf(thread.id, "running");
      expect(yield* runtimes.send(thread.id, { text: "two" })).toEqual({ queued: true });
      yield* session.completeTurn();
      yield* waitFor(
        "the queued send",
        Effect.sync(() => session.sent.length === 2),
      );
      // The send's own bookkeeping after it lands changes nothing clients see. Given real
      // time to arrive, a second `[]` would show here.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(queueTexts(events, thread.id)).toEqual([["two"], []]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("edits, reorders and removes queued inputs, publishing the full queue each time", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const events = yield* recordEvents;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );

      yield* runtimes.send(thread.id, { text: "two" });
      yield* runtimes.send(thread.id, { text: "three" });
      const [summary] = yield* runtimes.snapshot;
      const [two, three] = summary?.queue.map((q) => q.id) ?? [];

      yield* runtimes.editQueued(thread.id, two!, { text: "TWO" });
      yield* runtimes.reorderQueue(thread.id, [three!, two!]);
      const badOrder = yield* runtimes.reorderQueue(thread.id, [three!]).pipe(Effect.flip);
      expect(badOrder).toBeInstanceOf(InvalidState);
      const missing = yield* runtimes
        .removeQueued(thread.id, "nope" as QueueItemId)
        .pipe(Effect.flip);
      expect(missing).toBeInstanceOf(NotFound);
      expect(missing).toMatchObject({ entity: "queueItem" });
      yield* runtimes.removeQueued(thread.id, three!);

      yield* session.completeTurn();
      yield* waitFor(
        "the edited send",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one", "TWO"]);

      expect(queueTexts(events, thread.id)).toEqual([
        ["two"],
        ["two", "three"],
        ["TWO", "three"],
        ["three", "TWO"],
        ["TWO"],
        [],
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("steers a queued item into the running turn and drops it from the queue", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* runtimes.send(thread.id, { text: "two" });
      yield* runtimes.send(thread.id, { text: "three" });
      const [before] = yield* runtimes.snapshot;
      const [two, three] = before?.queue.map((q) => q.id) ?? [];

      yield* runtimes.steerQueued(thread.id, three!);
      expect(session.steered.map((i) => i.text)).toEqual(["three"]);
      const [after] = yield* runtimes.snapshot;
      expect(after?.queue.map((q) => q.id)).toEqual([two]);
      // Steered, not sent: the turn that was already running is the one that got it.
      expect(session.sent.map((i) => i.text)).toEqual(["one"]);
      expect(
        (yield* store.listMessages(thread.id))
          .filter((m) => m.role === "user")
          .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
      ).toEqual(["one", "three"]);

      const missing = yield* runtimes
        .steerQueued(thread.id, "nope" as QueueItemId)
        .pipe(Effect.flip);
      expect(missing).toBeInstanceOf(NotFound);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "joins input without a sender only where joinsWith says, reading the item as it is",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        yield* runtimes.sendOrJoin(thread.id, answer("1"), joinTexts, isAnswer);
        const [first] = yield* runtimes.snapshot;
        // The user edits the waiting answer; the next one joins the edit, not the text it replaced.
        yield* runtimes.editQueued(thread.id, first!.queue[0]!.id, { text: "answer 1, edited" });
        yield* runtimes.sendOrJoin(thread.id, answer("2"), joinTexts, isAnswer);
        yield* runtimes.send(thread.id, { text: "mine" });
        yield* runtimes.sendOrJoin(thread.id, answer("3"), joinTexts, isAnswer);
        const [summary] = yield* runtimes.snapshot;
        expect(summary?.queue.map((q) => q.input.text)).toEqual([
          "answer 1, edited+answer 2",
          "mine",
          "answer 3",
        ]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("joins a sender's queued input only while it is last, and never the user's", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      expect(yield* runtimes.sendOrJoin(thread.id, from("a", "A1"), joinTexts)).toEqual({
        queued: true,
      });
      expect(yield* runtimes.sendOrJoin(thread.id, from("a", "A2"), joinTexts)).toEqual({
        queued: true,
        joined: { queuedAt: 0 },
      });
      yield* runtimes.sendOrJoin(thread.id, from("b", "B1"), joinTexts);
      yield* runtimes.send(thread.id, { text: "mine" });
      yield* runtimes.sendOrJoin(thread.id, from("b", "B2"), joinTexts);
      yield* runtimes.send(thread.id, {
        text: "notice",
        notice: { kind: "review", number: 1, blockers: [], suggestions: [], ciFailed: [] },
        origin: from("b", "").origin,
      });
      yield* runtimes.sendOrJoin(thread.id, from("b", "B3"), joinTexts);
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.queue.map((q) => q.input.text)).toEqual([
        "A1+A2",
        "B1",
        "mine",
        "B2",
        "notice",
        "B3",
      ]);
      expect(summary?.queue[0]?.input.origin?.threadId).toBe("a");

      // A joined item that was edited counts as one message again.
      const b3 = summary!.queue[5]!.id;
      yield* runtimes.sendOrJoin(thread.id, from("b", "B4"), counted);
      yield* runtimes.editQueued(thread.id, b3, from("b", "edited"));
      yield* runtimes.sendOrJoin(thread.id, from("b", "B5"), counted);
      yield* runtimes.sendOrJoin(thread.id, from("b", "B6"), counted);
      const [edited] = yield* runtimes.snapshot;
      expect(edited?.queue[5]?.input.text).toBe("edited+B5@1+B6@2");

      yield* session.completeTurn();
      yield* waitFor(
        "the joined input",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent[1]?.text).toBe(fenceThreadMessage(from("a", "").origin, "A1+A2"));
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps a queued item when the steer fails, and never delivers it twice", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* runtimes.send(thread.id, { text: "two" });
      const [before] = yield* runtimes.snapshot;
      const two = before?.queue[0]?.id;

      yield* fake.setSteerFails(true);
      const failed = yield* runtimes.steerQueued(thread.id, two!).pipe(Effect.flip);
      expect(failed).toBeInstanceOf(InvalidState);
      const [kept] = yield* runtimes.snapshot;
      expect(kept?.queue.map((q) => q.input.text)).toEqual(["two"]);

      // The turn ends first: the drain owns the item, so steering it now finds nothing to send.
      yield* fake.setSteerFails(false);
      yield* session.completeTurn();
      yield* waitFor(
        "the drained send",
        Effect.sync(() => session.sent.length === 2),
      );
      const gone = yield* runtimes.steerQueued(thread.id, two!).pipe(Effect.flip);
      expect(gone).toBeInstanceOf(NotFound);
      expect(session.sent.map((i) => i.text)).toEqual(["one", "two"]);
      expect(session.steered).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("refuses to steer a queued item for an agent that can't take mid-turn input", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setSteerCapability(false);
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* runtimes.send(thread.id, { text: "two" });
      const [before] = yield* runtimes.snapshot;
      const error = yield* runtimes.steerQueued(thread.id, before!.queue[0]!.id).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
      expect(session.steered).toEqual([]);
      const [after] = yield* runtimes.snapshot;
      expect(after?.queue.map((q) => q.input.text)).toEqual(["two"]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "steers a notice into a running turn, keeping its payload, and sends one to an idle thread",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        const session = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        yield* runtimes.send(thread.id, { text: "mine" });

        const steered = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(1));
        expect(steered).toEqual({ queued: false, steered: true, replaced: false });
        expect(session.steered).toEqual([notice(1)]);
        const [during] = yield* runtimes.snapshot;
        expect(during?.queue.map((q) => q.input.text)).toEqual(["mine"]);
        const parts = (yield* store.listMessages(thread.id)).flatMap((m) => m.parts);
        expect(parts).toContainEqual(
          expect.objectContaining({ type: "data-review-notice", data: notice(1).notice }),
        );

        yield* session.completeTurn();
        yield* waitFor(
          "the queued send",
          Effect.sync(() => session.sent.length === 2),
        );
        yield* session.completeTurn();
        yield* waitFor(
          "the idle thread",
          runtimes.snapshot.pipe(Effect.map(([s]) => s?.status === "idle")),
        );
        const woke = yield* runtimes.sendNotice(thread.id, "ci:o/r#7", { text: "CI passed on #7" });
        expect(woke).toEqual({ queued: false, steered: false, replaced: false });
        expect(session.sent.map((i) => i.text)).toEqual(["one", "mine", "CI passed on #7"]);

        // Archived, it is woken by no monitor.
        yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
        const refused = yield* runtimes
          .sendNotice(thread.id, "ci:o/r#7", { text: "CI failed on #7" })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "InvalidState", message: "the thread is archived" });
        expect(session.sent).toHaveLength(3);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("holds a notice queued before an archive back from the archived agent", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setSteerCapability(false);
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* runtimes.sendNotice(thread.id, "run:o/r#9", { text: "run 9 finished" });
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* session.completeTurn();
      yield* waitFor(
        "the idle thread",
        runtimes.snapshot.pipe(Effect.map(([s]) => s?.status === "idle")),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one"]);
      const [held] = yield* runtimes.snapshot;
      expect(held?.queue.map((q) => q.input.text)).toEqual(["run 9 finished"]);

      // Sent by hand from its card, it goes all the same.
      yield* runtimes.steerQueued(thread.id, held!.queue[0]!.id);
      yield* waitFor(
        "the hand-sent notice",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent.map((i) => i.text)).toEqual(["one", "run 9 finished"]);
      const [after] = yield* runtimes.snapshot;
      expect(after?.queue).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("queues a notice an agent can't steer, the newest for a key replacing the last", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      yield* fake.setSteerCapability(false);
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const queued = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(1));
      expect(queued).toEqual({ queued: true, steered: false, replaced: false });
      yield* runtimes.send(thread.id, { text: "mine" });
      yield* runtimes.sendOrJoin(thread.id, from("boss", "a"), joinTexts);
      yield* runtimes.sendNotice(thread.id, "ci:o/r#7", { text: "CI failed on #7" });
      yield* runtimes.sendNotice(thread.id, "review:o/r#8", notice(1, 8));
      const [before] = yield* runtimes.snapshot;

      const replaced = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(2));
      expect(replaced).toEqual({ queued: true, steered: false, replaced: true });
      yield* runtimes.sendNotice(thread.id, "ci:o/r#7", { text: "CI passed on #7" });
      const [after] = yield* runtimes.snapshot;
      expect(after?.queue.map((q) => q.id)).toEqual(before?.queue.map((q) => q.id));
      expect(after?.queue.map((q) => q.input.text)).toEqual([
        notice(2).text,
        "mine",
        "a",
        "CI passed on #7",
        notice(1, 8).text,
      ]);
      expect(after?.queue[0]?.input.notice).toEqual(notice(2).notice);

      // An edited notice is the user's now.
      yield* runtimes.editQueued(thread.id, after!.queue[0]!.id, { text: "edited" });
      yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(3));
      const [edited] = yield* runtimes.snapshot;
      expect(edited?.queue.map((q) => q.input.text).slice(0, 1)).toEqual(["edited"]);
      expect(edited?.queue.at(-1)?.input.text).toBe(notice(3).text);
      expect(session.steered).toEqual([]);

      yield* runtimes.dropNotices(thread.id, (key) => key.startsWith("ci:"));
      const [dropped] = yield* runtimes.snapshot;
      expect(dropped?.queue.map((q) => q.input.text)).toEqual([
        "edited",
        "mine",
        "a",
        notice(1, 8).text,
        notice(3).text,
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "queues a notice whose steer fails; a newer one steers only if nothing waits behind it",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/work/repo",
          checkout: { kind: "main", path: "/work/repo" },
          input: { text: "one" },
        });
        const session = yield* waitFor(
          "the first send",
          fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
        );
        const texts = runtimes.snapshot.pipe(
          Effect.map(([s]) => s?.queue.map((q) => q.input.text)),
        );
        yield* fake.setSteerFails(true);
        const failed = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(1));
        expect(failed).toEqual({ queued: true, steered: false, replaced: false });
        expect(yield* texts).toEqual([notice(1).text]);

        yield* fake.setSteerFails(false);
        const steered = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(2));
        expect(steered).toEqual({ queued: false, steered: true, replaced: true });
        expect(session.steered.map((i) => i.text)).toEqual([notice(2).text]);
        expect(yield* texts).toEqual([]);

        yield* fake.setSteerFails(true);
        yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(3));
        yield* runtimes.send(thread.id, { text: "mine" });
        yield* fake.setSteerFails(false);
        // Steering it would put the PR ahead of what the user queued after the older update.
        const kept = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(4));
        expect(kept).toEqual({ queued: true, steered: false, replaced: true });
        expect(yield* texts).toEqual([notice(4).text, "mine"]);
        expect(session.steered).toHaveLength(1);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("takes a notice whose steer fails out of the transcript until it is sent", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
        input: { text: "one" },
      });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* fake.setSteerFails(true);
      const failed = yield* runtimes.sendNotice(thread.id, "review:o/r#7", notice(1));
      expect(failed).toEqual({ queued: true, steered: false, replaced: false });
      // The agent never took it, so the turn it was steered into doesn't show it.
      expect(yield* userTexts(thread.id)).toEqual(["one"]);

      yield* fake.setSteerFails(false);
      yield* session.completeTurn();
      yield* waitFor(
        "the queued notice sent",
        Effect.sync(() => session.sent.length === 2),
      );
      const texts = yield* userTexts(thread.id);
      expect(texts.filter((text) => text === notice(1).text)).toHaveLength(1);
      expect(session.steered).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("publishes the session identity and includes it in the snapshot", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const events = yield* recordEvents;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* waitFor(
        "the identity event",
        Effect.sync(() => events.some((e) => e.type === "thread.identity")),
      );
      expect(events).toContainEqual({
        type: "thread.identity",
        threadId: thread.id,
        identity: { model: "fake", commands: [] },
      });
      const [summary] = yield* runtimes.snapshot;
      expect(summary?.identity).toEqual({ model: "fake", commands: [] });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("settles a thread by completedAt with the reason recorded", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      const settled = yield* runtimes.markCompleted(thread.id, "user");
      expect(settled.completedAt).toBeTypeOf("number");
      expect(yield* store.getCompletedReason(thread.id)).toBe("user");
      const reopened = yield* runtimes.markCompleted(thread.id, undefined);
      expect(reopened.completedAt).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the user's completion when a turn starts", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: "/work/repo",
        checkout: { kind: "main", path: "/work/repo" },
      });
      yield* runtimes.markCompleted(thread.id, "user");
      yield* runtimes.send(thread.id, { text: "one more thing" });
      const session = yield* fake.latest(thread.id);
      yield* waitFor(
        "the turn",
        Effect.sync(() => session.sent.length === 1),
      );
      expect(yield* store.getCompletedReason(thread.id)).toBe("user");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
