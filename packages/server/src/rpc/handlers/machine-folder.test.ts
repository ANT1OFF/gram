import { describe, expect, it } from "@effect/vitest";
import {
  type Checkout,
  HostId,
  InvalidState,
  isFolderProject,
  machineOfProject,
  machineProjectRoot,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { gitPlatformTest } from "../../git/platform.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { CheckoutService, TurnHooks } from "../../runtime/hooks.ts";
import { makeRuntimeTestLayer } from "../../runtime/test-harness.ts";
import { LOCAL_APP_HEADER, localAppHeadersForTests } from "../../http/local-app.ts";
import { MACHINE_FOLDER_LOCAL_ONLY, threadHandlers } from "./threads.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
/** A folder on the machine, named as it is there: nothing at this path is read on this disk. */
const THERE = "/home/dev/scratch";

/**
 * Checkouts as the placed service makes them: a machine folder is the machine's host's to check,
 * which this stands in for, recording what it was asked.
 */
const asked: Array<string> = [];
const MachineCheckouts: Layer.Layer<CheckoutService> = Layer.effect(
  CheckoutService,
  Effect.gen(function* () {
    const base = yield* CheckoutService;
    return CheckoutService.of({
      ...base,
      prepare: (request, open, projectRoot) =>
        request.kind === "machineFolder"
          ? Effect.sync((): Checkout => {
              asked.push(`${request.hostId}:${request.path}`);
              return { kind: "main", path: THERE, hostId: request.hostId };
            })
          : base.prepare(request, open, projectRoot),
    });
  }),
).pipe(Layer.provide(CheckoutService.layerNoGit));

/** How the local app's connection reaches a handler: marked by the auth middleware. */
const LOCAL_APP = { headers: localAppHeadersForTests() };

const TestLayer = Layer.merge(
  makeRuntimeTestLayer(TurnHooks.layerNoop, MachineCheckouts),
  gitPlatformTest(),
);

describe("thread.create in a folder on a joined machine", () => {
  it.effect("files the thread under the machine, never a folder of this disk", () =>
    Effect.gen(function* () {
      asked.length = 0;
      const handlers = yield* threadHandlers;
      const store = yield* ThreadStore;
      const thread = yield* handlers["thread.create"](
        {
          // Not on this disk: the server must not look for it here.
          projectRoot: THERE,
          checkout: { kind: "machineFolder", hostId: MACHINE, path: "~/scratch" },
        },
        LOCAL_APP,
      );
      expect(asked).toEqual([`${MACHINE}:~/scratch`]);
      expect(thread.checkout).toEqual({ kind: "main", path: THERE, hostId: MACHINE });

      const projects = yield* store.listProjects;
      expect(projects).toHaveLength(1);
      const [project] = projects;
      expect(project?.root).toBe(machineProjectRoot(MACHINE));
      expect(project?.id).toBe(thread.projectId);
      expect(machineOfProject(project!)).toBe(MACHINE);
      expect(isFolderProject(project!)).toBe(false);

      // A second chat there joins the same project.
      const again = yield* handlers["thread.create"](
        {
          projectRoot: THERE,
          checkout: { kind: "machineFolder", hostId: MACHINE, path: "~/scratch" },
        },
        LOCAL_APP,
      );
      expect(again.projectId).toBe(thread.projectId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("won't resume a past session of this machine in a folder on another", () =>
    Effect.gen(function* () {
      const handlers = yield* threadHandlers;
      const error = yield* handlers["thread.create"](
        {
          projectRoot: THERE,
          checkout: { kind: "machineFolder", hostId: MACHINE, path: "~" },
          resumeSessionId: "session-1",
        },
        LOCAL_APP,
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("starts nothing for a caller that isn't the local app, whatever it says", () =>
    Effect.gen(function* () {
      asked.length = 0;
      const handlers = yield* threadHandlers;
      const store = yield* ThreadStore;
      const request = {
        projectRoot: THERE,
        checkout: { kind: "machineFolder" as const, hostId: MACHINE, path: "~/scratch" },
      };
      for (const call of [
        undefined,
        { headers: {} },
        // The header without this run's secret: a phone can name it, not know its value.
        { headers: { [LOCAL_APP_HEADER]: "0".repeat(64) } },
      ]) {
        const refused = yield* handlers["thread.create"](request, call).pipe(Effect.flip);
        expect(refused).toEqual(new InvalidState({ message: MACHINE_FOLDER_LOCAL_ONLY }));
      }
      expect(asked).toEqual([]);
      expect(yield* store.listThreads).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("never forks into a machine folder", () =>
    Effect.gen(function* () {
      const handlers = yield* threadHandlers;
      const thread = yield* handlers["thread.create"](
        {
          projectRoot: THERE,
          checkout: { kind: "machineFolder", hostId: MACHINE, path: "~/scratch" },
        },
        LOCAL_APP,
      );
      const refused = yield* handlers["thread.fork"]({
        threadId: thread.id,
        checkout: { kind: "machineFolder", hostId: MACHINE, path: "~/other" },
      }).pipe(Effect.flip);
      expect(refused).toEqual(
        new InvalidState({
          message: "A fork goes in its chat's folder or a new worktree, not another folder.",
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a machine folder placed on this machine", () =>
    Effect.gen(function* () {
      const checkouts = yield* CheckoutService;
      const error = yield* checkouts
        .prepare({ kind: "machineFolder", hostId: HostId.make("local"), path: "/tmp" }, [], "")
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "A folder on this machine is the thread's current checkout, not a machine folder.",
      );
    }).pipe(Effect.provide(Layer.merge(makeRuntimeTestLayer(), gitPlatformTest()))),
  );
});
