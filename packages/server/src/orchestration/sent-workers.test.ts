import { describe, expect, it } from "@effect/vitest";
import type { HostedThreadWaited, SentWorkTarget, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import type { SentWorkPortShape } from "../embedding/sent-work-port.ts";
import { run } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { pickTarget, reportOf } from "./sent-workers.ts";
import { Orchestration } from "./service.ts";
import { makeWorld, openOrchestrator, settle, waitReal, withServer } from "./test-harness.ts";

const PLATFORM: SentWorkTarget = {
  origin: "https://gram.example.com",
  server: "Example",
  workspaceId: "w1",
  workspace: "Platform",
  organisation: "Example Co",
};

/** The desktop app as the server sees it: what it was asked, and the waits a test answers. */
const fakeApp = Effect.gen(function* () {
  const waits = yield* Queue.unbounded<HostedThreadWaited>();
  const asked: Array<{ readonly op: string } & Record<string, unknown>> = [];
  let made = 0;
  const port: SentWorkPortShape = {
    available: true,
    targets: () => Effect.succeed({ ok: true, targets: [PLATFORM] }),
    send: (origin, workspaceId, work) =>
      Effect.sync(() => {
        asked.push({ op: "send", origin, workspaceId, ...work });
        made += 1;
        return { ok: true as const, threadId: `t-there-${made}`, branch: `thread/t-there-${made}` };
      }),
    // Blocks until the test says what happened there, as a wait there would.
    wait: (origin, workspaceId, threadId, wait) =>
      Effect.sync(() => asked.push({ op: "wait", origin, workspaceId, threadId, ...wait })).pipe(
        Effect.andThen(Queue.take(waits)),
        Effect.map((waited) => ({ ok: true as const, waited })),
      ),
    message: (origin, workspaceId, threadId, message) =>
      Effect.sync(() => {
        asked.push({ op: "message", origin, workspaceId, threadId, ...message });
        return { ok: true as const, queued: false };
      }),
    stop: (origin, workspaceId, threadId) =>
      Effect.sync(() => {
        asked.push({ op: "stop", origin, workspaceId, threadId });
        return { ok: true as const };
      }),
  };
  return { port, waits, asked };
});

const BRIEF = {
  project: "shop",
  feature: "refunds",
  title: "Idempotent refund webhooks",
  brief: "Make refund webhooks idempotent.",
};

describe("a worker sent to a server", () => {
  it.effect(
    "goes only where the workspace allows it, runs nothing here, and reports what it says there",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        // The work goes from the remote: the project names one a server can clone.
        run(world.repo, "remote", "add", "origin", "https://github.com/acme/shop.git");
        const app = yield* fakeApp;
        world.sentWork = app.port;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { session, thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
            const orchestration = yield* Orchestration;
            const store = yield* ThreadStore;

            // Off by default: nothing is sent.
            const refused = yield* session.callTool("send_worker", BRIEF).pipe(Effect.flip);
            expect(refused.message).toContain("doesn't send work to servers");
            expect(app.asked).toEqual([]);

            const state = yield* store.getWorkspace(workspaceId as WorkspaceId);
            yield* orchestration.setCharter(workspaceId, { ...state.charter, sendWork: true });
            yield* settle;
            const sent = (yield* session.callTool("send_worker", {
              ...BRIEF,
              clientRequestId: "refunds-1",
            })) as { readonly threadId: ThreadId; readonly runsOn: string };
            expect(sent.runsOn).toBe("Platform · gram.example.com");
            expect(app.asked[0]).toEqual({
              op: "send",
              origin: PLATFORM.origin,
              workspaceId: "w1",
              repositories: ["acme/shop"],
              text: BRIEF.brief,
              title: BRIEF.title,
              clientKey: expect.any(String),
            });

            // Its record here is the orchestrator's worker, and opens no session.
            const worker = yield* store.getThread(sent.threadId);
            expect(worker.spawnedBy?.threadId).toBe(orchestrator.id);
            expect(worker.sentTo).toMatchObject({
              origin: PLATFORM.origin,
              workspaceId: "w1",
              threadId: "t-there-1",
              state: "running",
            });
            const fake = yield* FakeAgentControl;
            expect(fake.sessions.some((each) => each.options.threadId === sent.threadId)).toBe(
              false,
            );
            // A message typed into it here doesn't start anything here.
            const typed = yield* (yield* ThreadRuntimes)
              .send(sent.threadId, { text: "Hello?" })
              .pipe(Effect.flip);
            expect(typed.message).toContain("runs on a server");

            // A retry with its id finds it, and sends nothing again.
            const again = (yield* session.callTool("send_worker", {
              ...BRIEF,
              clientRequestId: "refunds-1",
            })) as { readonly threadId: ThreadId; readonly existing?: boolean };
            expect(again).toMatchObject({ threadId: sent.threadId, existing: true });
            expect(app.asked.filter((each) => each.op === "send")).toHaveLength(1);

            // It replies there: the orchestrator has it as the worker's report.
            yield* Queue.offer(app.waits, {
              happened: true,
              latest: "m-2",
              reply: "The handler now keeps seen event ids.",
              thread: { title: BRIEF.title, state: "running", working: false },
            });
            const reports = yield* waitReal(
              "its report",
              store
                .listWorkerReports(workspaceId as WorkspaceId, 0)
                .pipe(Effect.map((all) => (all.length > 0 ? all : undefined))),
            );
            expect(reports.at(-1)?.report).toMatchObject({
              threadId: sent.threadId,
              state: "progress",
              summary: "The handler now keeps seen event ids.",
            });
            // The next wait starts after what it has read, a moment later.
            yield* settle;
            yield* TestClock.adjust("2 seconds");
            yield* waitReal(
              "the next wait",
              Effect.sync(() =>
                app.asked.some((each) => each.op === "wait" && each["after"] === "m-2"),
              ),
            );

            // A question there is reported though it wrote nothing new.
            yield* Queue.offer(app.waits, {
              happened: false,
              latest: "m-2",
              thread: { title: BRIEF.title, state: "waiting", working: false },
            });
            yield* waitReal(
              "its question",
              store
                .listWorkerReports(workspaceId as WorkspaceId, 0)
                .pipe(
                  Effect.map((all) => (all.at(-1)?.report.state === "question" ? all : undefined)),
                ),
            );

            // The orchestrator's message and stop go there. It is sent while a wait is open.
            const waits = () => app.asked.filter((each) => each.op === "wait").length;
            const before = waits();
            yield* settle;
            yield* TestClock.adjust("2 seconds");
            yield* waitReal(
              "a wait open",
              Effect.sync(() => (waits() > before ? true : undefined)),
            );
            expect(
              yield* session.callTool("send_message", {
                threadId: sent.threadId,
                text: "Add a test for a replayed event.",
              }),
            ).toMatchObject({ delivered: "sent" });
            expect(app.asked.find((each) => each.op === "message")).toMatchObject({
              threadId: "t-there-1",
              text: "Add a test for a replayed event.",
            });
            // That wait hears the turn before the message end: not its last, so it is followed on.
            yield* Queue.offer(app.waits, {
              happened: true,
              latest: "m-3",
              reply: "Turn ended.",
              thread: { title: BRIEF.title, state: "done", working: false },
            });
            yield* waitReal(
              "the turn's report",
              store
                .listWorkerReports(workspaceId as WorkspaceId, 0)
                .pipe(
                  Effect.map((all) =>
                    all.at(-1)?.report.summary === "Turn ended." ? all : undefined,
                  ),
                ),
            );
            expect((yield* store.getThread(sent.threadId)).sentTo?.state).toBe("running");

            // Finished there, then asked again: it is followed again.
            yield* settle;
            yield* TestClock.adjust("2 seconds");
            yield* Queue.offer(app.waits, {
              happened: true,
              latest: "m-4",
              reply: "Done.",
              thread: { title: BRIEF.title, state: "done", working: false },
            });
            yield* waitReal(
              "its end",
              store
                .getThread(sent.threadId)
                .pipe(Effect.map((each) => (each.sentTo?.state === "done" ? each : undefined))),
            );
            yield* session.callTool("send_message", {
              threadId: sent.threadId,
              text: "Address the review comments.",
            });
            expect((yield* store.getThread(sent.threadId)).sentTo?.state).toBe("running");
            expect(
              yield* session.callTool("stop_thread", { threadId: sent.threadId }),
            ).toMatchObject({ stopped: true });
            expect(app.asked.find((each) => each.op === "stop")).toMatchObject({
              threadId: "t-there-1",
            });
          }),
        );
      }),
  );
});

describe("where a worker goes, and what it reports", () => {
  it("picks the one workspace there is, or the one named, and lists them otherwise", () => {
    expect(pickTarget([PLATFORM], undefined)).toBe(PLATFORM);
    const research = { ...PLATFORM, workspaceId: "w2", workspace: "Research" };
    expect(pickTarget([PLATFORM, research], "research")).toBe(research);
    expect(pickTarget([PLATFORM, research], "Platform · gram.example.com")).toBe(PLATFORM);
    expect(pickTarget([PLATFORM, research], undefined)).toContain('"Research · gram.example.com"');
    expect(pickTarget([], undefined)).toContain("Settings → Machines");
  });

  it("reports a question as a question and a failure as blocked", () => {
    expect(reportOf({ state: "waiting", server: "Example" }).state).toBe("question");
    expect(reportOf({ state: "failed", server: "Example" }).state).toBe("blocked");
    expect(reportOf({ state: "done", server: "Example", reply: "Merged." })).toEqual({
      state: "done",
      summary: "Merged.",
    });
    expect(
      reportOf({ state: "running", server: "Example", reply: "x".repeat(2000) }).summary,
    ).toHaveLength(1000);
  });
});
