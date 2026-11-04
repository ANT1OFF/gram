import {
  cloneFolderOf,
  InvalidState,
  NotFound,
  ProjectRpcs,
  type ProjectId,
} from "@gram/contracts";
import { Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cloneRepo, makeCloneSuggestions } from "../../fs/clone.ts";
import { expandHome, registerRepo, repositoryCandidates } from "../../fs/folders.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import {
  readProjectScripts,
  saveProjectScripts,
  ScriptsError,
} from "../../scripts/project-scripts.ts";
import { logDefects, type Handlers } from "./common.ts";
import { sessionHandlers } from "./sessions.ts";

/**
 * `projects.list`, `projects.add`, `projects.repositories`, `projects.clone`,
 * `projects.setBookmarked` and `projects.forget`.
 */
const projectHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const provide = Effect.provideService(Proc, proc);
  const suggestions = makeCloneSuggestions(homedir());
  const projectRoot = (projectId: ProjectId) =>
    store.listProjects.pipe(
      Effect.flatMap((projects) => {
        const project = projects.find((each) => each.id === projectId);
        return project === undefined
          ? Effect.fail(new NotFound({ entity: "project", id: projectId }))
          : Effect.succeed(project.root);
      }),
    );

  return {
    "projects.list": () => store.listProjects,
    "projects.add": ({ root }) =>
      registerRepo(store, root).pipe(Effect.map(({ project }) => project)),
    "projects.repositories": () =>
      Effect.gen(function* () {
        const settings = yield* store.getSettings;
        // Where the user keeps repositories: the folder `/new` starts in, and where clones go.
        const folders = [settings.agents.defaultFolder, cloneFolderOf(settings)].flatMap(
          (folder) =>
            folder === undefined || folder.trim() === ""
              ? []
              : [resolve(expandHome(folder.trim()))],
        );
        return yield* repositoryCandidates(yield* store.listProjects, folders);
      }),
    "projects.clone": ({ remote, into }) =>
      Effect.gen(function* () {
        const cloneFolder = cloneFolderOf(yield* store.getSettings);
        return yield* provide(cloneRepo(store, { remote, into, cloneFolder }));
      }),
    "projects.cloneSuggestions": () => provide(suggestions),
    "projects.setBookmarked": ({ projectId, bookmarked }) =>
      store.setProjectBookmarked(projectId, bookmarked),
    "projects.forget": ({ projectId }) => store.forgetProject(projectId),
    "projects.scripts": ({ projectId }) =>
      projectRoot(projectId).pipe(
        Effect.flatMap((root) => Effect.promise(() => readProjectScripts(root, projectId))),
      ),
    "projects.saveScripts": ({ projectId, scripts }) =>
      projectRoot(projectId).pipe(
        Effect.flatMap((root) =>
          Effect.tryPromise({
            try: () => saveProjectScripts(root, projectId, scripts),
            catch: (error) =>
              new InvalidState({
                message:
                  error instanceof ScriptsError
                    ? error.message
                    : "Can't save the project's scripts.",
              }),
          }),
        ),
      ),
  } satisfies Partial<Handlers>;
});

/** The projects group's handler layer: projects, and the agents' past sessions in them. */
export const ProjectHandlersLive = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const handlers = { ...(yield* projectHandlers), ...(yield* sessionHandlers) };
    return ProjectRpcs.of(logDefects(ProjectRpcs, handlers));
  }),
);
