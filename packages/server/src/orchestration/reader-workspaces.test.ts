import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { notePrivacy, ReadingAs } from "../embedding/readable-by.ts";
import { projectHandlers } from "../rpc/handlers/projects.ts";
import { Orchestration } from "./service.ts";
import { inServer } from "./service-kit.ts";
import { openOrchestrator } from "./test-harness.ts";

const as = (subject: string) => Effect.provideService(ReadingAs, { subject });

describe("a workspace readable by one person, named by its project or id", () => {
  it.effect("is never reached by anyone else", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { project, thread, workspaceId } = yield* openOrchestrator(world);
        notePrivacy({ id: thread.id, readableBy: "ada", workspaceId });

        const preflight = yield* orchestration
          .taskPreflight({ target: { projectId: project.id } })
          .pipe(as("bob"));
        expect(preflight.orchestratorThreadId).toBeUndefined();
        const save = yield* orchestration
          .saveWorkspace({
            id: workspaceId,
            name: "Renamed by Bob",
            projectIds: [project.id],
            homeProjectId: project.id,
          })
          .pipe(as("bob"), Effect.flip);
        expect(save).toMatchObject({ _tag: "NotFound", entity: "workspace" });
        const opened = yield* orchestration.open({ projectId: project.id }).pipe(as("bob"));
        expect(opened.id).not.toBe(thread.id);
        expect(opened.workspaceId).not.toBe(workspaceId);

        // Its own person still reaches it as before.
        const own = yield* orchestration
          .taskPreflight({ target: { projectId: project.id } })
          .pipe(as("ada"));
        expect(own.orchestratorThreadId).toBe(thread.id);
        const states = yield* orchestration.listWorkspaces;
        expect(states.find((state) => state.workspace.id === workspaceId)?.workspace.name).toBe(
          project.name,
        );
      }),
    ),
  );

  it.effect("leaves a private thread's home folder out of the project list", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { project, thread, workspaceId } = yield* openOrchestrator(world);
        notePrivacy({
          id: thread.id,
          readableBy: "ada",
          workspaceId,
          checkout: { path: project.root },
        });
        const handlers = yield* projectHandlers;
        const roots = (subject: string) =>
          handlers["projects.list"]().pipe(
            Effect.map((projects) => projects.map((each) => each.id)),
            as(subject),
          );
        expect(yield* roots("bob")).not.toContain(project.id);
        expect(yield* roots("ada")).toContain(project.id);
      }),
    ),
  );
});
