// The `/machines/stop/*` routes as an embedder calls them, with a machine whose restores the test
// lets through one at a time: a resume started as a job and polled until done, a synchronous
// resume that joins it rather than running again, and a restart of this Gram in the middle of one.

import { describe, expect, it } from "@effect/vitest";
import { type HostId, type HostStopRestored, type Thread, type ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { makeMachineJobs, type MachineJob, type MachineJobs } from "../host/machine-jobs.ts";
import { cloneIdentityOf } from "../host/repos.ts";
import type { RestoreRequest } from "../host/stop.ts";
import { type MachineMarksByHost, makeStopMarks, type StopMarks } from "../host/stop-marks.ts";
import type { StopResumeDeps } from "../host/stop-resume.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  hostStopRoute,
  MACHINES_JOBS_GET_PATH,
  MACHINES_STOP_RESUME_PATH,
  MACHINES_STOP_RESUME_START_PATH,
} from "./host-stop-routes.ts";

const MACHINE = "m-1" as HostId;
const URL = "https://git.example.test/acme/widgets.git";
const COMMIT = "a".repeat(40);

const thread = (id: string, path: string) =>
  ({
    id: id as ThreadId,
    checkout: { kind: "worktree", hostId: MACHINE, path, cloneIdentity: cloneIdentityOf(URL)! },
  }) as unknown as Thread;

const THREADS = [thread("t-a", "/clones/a"), thread("t-b", "/clones/b")];

/** A machine with an empty disk, whose restores wait for the test to let each through. */
const machine = (stops: StopMarks, disk = new Set<string>()) => {
  const asked: Array<RestoreRequest> = [];
  const gates = new Map<string, Deferred.Deferred<void>>();
  const gate = (cwd: string) => {
    let open = gates.get(cwd);
    if (open === undefined) gates.set(cwd, (open = Deferred.makeUnsafe<void>()));
    return open;
  };
  const restore = (request: RestoreRequest) =>
    Effect.gen(function* () {
      asked.push(request);
      yield* Deferred.await(gate(request.cwd));
      disk.add(request.cwd);
      return { restored: true, commit: COMMIT } satisfies HostStopRestored;
    });
  const deps = {
    hosts: {
      connection: () =>
        Effect.succeed({
          git: { present: (cwd: string) => Effect.succeed(disk.has(cwd)) },
          stop: { restore },
        }),
      machines: { get: () => ({ confirmedAt: 1 }) },
      stops,
    },
    store: { listThreads: Effect.succeed(THREADS) },
    runtimes: { startSession: () => Effect.void },
    settings: { getSettings: Effect.succeed({ experimental: { embedding: true } }) },
  } as unknown as StopResumeDeps;
  const letThrough = (cwd: string) => Deferred.succeed(gate(cwd), undefined);
  return { deps, asked, letThrough, disk };
};

const post = (deps: StopResumeDeps, jobs: MachineJobs, path: string, body: unknown) =>
  Effect.gen(function* () {
    const text = JSON.stringify(body);
    const response = yield* hostStopRoute({ ...deps, jobs } as never, path).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(`http://127.0.0.1${path}`, {
            method: "POST",
            headers: {
              origin: "http://127.0.0.1",
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(text)),
            },
            body: text,
          }),
        ),
      ),
      Effect.map((answer) => HttpServerResponse.toWeb(answer)),
    );
    return {
      status: response.status,
      body: (yield* Effect.promise(() => response.json())) as Record<string, unknown>,
    };
  });

/** Polls the job, each poll waiting for its next change, until `until` says of it. */
const pollUntil = (
  deps: StopResumeDeps,
  jobs: MachineJobs,
  id: string,
  until: (job: MachineJob) => boolean,
) =>
  Effect.gen(function* () {
    let seen: number | undefined;
    for (let polls = 0; polls < 50; polls++) {
      const { status, body } = yield* post(deps, jobs, MACHINES_JOBS_GET_PATH, {
        job: id,
        ...(seen === undefined ? {} : { seen, waitMs: 20_000 }),
      });
      expect(status).toBe(200);
      const job = body["job"] as MachineJob;
      if (until(job)) return job;
      seen = job.version;
    }
    throw new Error("the job never got there");
  });

/** The machine dialled in on a disk other than the one its folders were last seen on. */
const backOnAnotherDisk = (stops: StopMarks) => {
  stops.arrive(MACHINE, { diskId: "disk-aaaaaaaa", bootId: "boot-aaaaaaaa" });
  stops.arrive(MACHINE, { diskId: "disk-bbbbbbbb", bootId: "boot-bbbbbbbb" });
  expect(stops.owes(MACHINE)).toBe(true);
};

/** Marks kept across a restart of this Gram, as `machine-marks.json` keeps them. */
const durableMarks = () => {
  let saved: MachineMarksByHost = {};
  const open = () =>
    makeStopMarks(undefined, undefined, undefined, undefined, {
      initial: saved,
      save: (all) => {
        saved = structuredClone(all);
      },
    });
  return { open };
};

describe("a machine's resume as a job, through its routes", () => {
  it.effect("is started, polled until done, and joined by a synchronous resume meanwhile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stops = makeStopMarks();
        backOnAnotherDisk(stops);
        const { deps, asked, letThrough } = machine(stops);
        const scope = yield* Scope.make();
        const jobs = yield* Scope.provide(scope)(makeMachineJobs());
        const started = yield* post(deps, jobs, MACHINES_STOP_RESUME_START_PATH, {
          id: MACHINE,
          key: "wake-1",
        });
        expect(started.status).toBe(202);
        const id = (started.body["job"] as MachineJob).id;
        // Under way on one folder; the rest wait their turn on the host.
        const first = yield* pollUntil(deps, jobs, id, (job) =>
          (job.folders ?? []).some((folder) => folder.state === "running"),
        );
        expect(first).toMatchObject({
          kind: "resume",
          state: "running",
          progress: { done: 0, total: 2 },
        });
        expect(asked.map((request) => request.cwd)).toEqual(["/clones/a"]);
        // An embedder whose call timed out asks again, synchronously: it waits on the same run.
        const asking = yield* Deferred.make<void>();
        const seenAsking: MachineJobs = {
          ...jobs,
          start: (spec) => Effect.tap(jobs.start(spec), () => Deferred.succeed(asking, undefined)),
        };
        const sync = yield* Effect.forkScoped(
          post(deps, seenAsking, MACHINES_STOP_RESUME_PATH, { id: MACHINE }),
        );
        yield* Deferred.await(asking);
        yield* letThrough("/clones/a");
        const half = yield* pollUntil(deps, jobs, id, (job) => job.progress.done === 1);
        expect(half.folders).toEqual([
          { threadId: "t-a", cwd: "/clones/a", state: "restored" },
          { threadId: "t-b", cwd: "/clones/b", state: "running" },
        ]);
        yield* letThrough("/clones/b");
        const done = yield* pollUntil(deps, jobs, id, (job) => job.state === "done");
        expect(done.result).toMatchObject({
          restored: [
            { threadId: "t-a", cwd: "/clones/a", commit: COMMIT },
            { threadId: "t-b", cwd: "/clones/b", commit: COMMIT },
          ],
        });
        const joined = yield* Fiber.join(sync);
        expect(joined.status).toBe(200);
        expect(joined.body).toEqual(done.result);
        // Each folder asked of the host once: the synchronous resume ran nothing of its own.
        expect(asked.map((request) => request.cwd)).toEqual(["/clones/a", "/clones/b"]);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.effect("after a restart is unknown, and started again puts back only what is still owed", () =>
    Effect.gen(function* () {
      const marks = durableMarks();
      const before = marks.open();
      backOnAnotherDisk(before);
      const first = machine(before);
      const scope = yield* Scope.make();
      const jobs = yield* Scope.provide(scope)(makeMachineJobs());
      const started = yield* post(first.deps, jobs, MACHINES_STOP_RESUME_START_PATH, {
        id: MACHINE,
        key: "wake-1",
      });
      const id = (started.body["job"] as MachineJob).id;
      yield* first.letThrough("/clones/a");
      yield* pollUntil(first.deps, jobs, id, (job) => job.progress.done === 1);
      // This Gram stops with the second folder still under way.
      yield* Scope.close(scope, Exit.void);

      const after = marks.open();
      expect(after.owes(MACHINE)).toBe(true);
      // The same disk: the first folder is on it, the second part-way, as far as anyone knows.
      expect([...first.disk]).toEqual(["/clones/a"]);
      const second = machine(after, first.disk);
      const restarted = yield* Scope.provide(yield* Scope.make())(makeMachineJobs());
      const lost = yield* post(second.deps, restarted, MACHINES_JOBS_GET_PATH, { job: id });
      expect(lost.status).toBe(404);
      const again = yield* post(second.deps, restarted, MACHINES_STOP_RESUME_START_PATH, {
        id: MACHINE,
        key: "wake-1",
      });
      expect(again.body["joined"]).toBe(false);
      yield* second.letThrough("/clones/b");
      const done = yield* pollUntil(
        second.deps,
        restarted,
        (again.body["job"] as MachineJob).id,
        (job) => job.state === "done",
      );
      expect(done.state).toBe("done");
      // Only the folder the first run didn't finish with is asked of the host, and checked
      // there (`pending`): the one confirmed back isn't put back twice.
      expect(second.asked).toEqual([expect.objectContaining({ cwd: "/clones/b", pending: true })]);
      expect(after.owes(MACHINE)).toBe(false);
    }),
  );
});
