import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { notePrivacy, ReadingAs } from "../embedding/readable-by.ts";
import { projectHandlers } from "../rpc/handlers/projects.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
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
          .pipe(as("bob"), Effect.flip);
        expect(preflight).toMatchObject({ _tag: "NotFound", entity: "project" });
        const save = yield* orchestration
          .saveWorkspace({
            id: workspaceId,
            name: "Renamed by Bob",
            projectIds: [project.id],
            homeProjectId: project.id,
          })
          .pipe(as("bob"), Effect.flip);
        expect(save).toMatchObject({ _tag: "NotFound", entity: "workspace" });
        // Nor does naming the project make Bob a workspace of his own over Ada's folder.
        const before = (yield* orchestration.listWorkspaces).length;
        const opened = yield* orchestration
          .open({ projectId: project.id })
          .pipe(as("bob"), Effect.flip);
        expect(opened).toMatchObject({ _tag: "NotFound", entity: "project" });
        expect(yield* orchestration.listWorkspaces).toHaveLength(before);

        // A name only Ada's workspace has is no clash for Bob: a refusal would say it is there.
        const other = yield* (yield* ThreadStore).ensureProject({
          root: `${world.dir}/bobs`,
          name: "bobs",
        });
        const bobs = yield* orchestration
          .saveWorkspace({ name: project.name, projectIds: [other.id], homeProjectId: other.id })
          .pipe(as("bob"));
        expect(bobs.workspace.name).toBe(project.name);

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

  it.effect("is not made for anyone else over a private thread's own folder", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const store = yield* ThreadStore;
        const home = yield* store.ensureProject({ root: world.repo, name: "ada-home" });
        notePrivacy({
          id: "t-home-ada" as ThreadId,
          readableBy: "ada",
          checkout: { path: world.repo },
        });
        const opened = yield* orchestration
          .open({ projectId: home.id })
          .pipe(as("bob"), Effect.flip);
        expect(opened).toMatchObject({ _tag: "NotFound", entity: "project" });
        expect(
          (yield* orchestration.listWorkspaces).some((state) =>
            state.workspace.projectIds.includes(home.id),
          ),
        ).toBe(false);
      }),
    ),
  );
});
