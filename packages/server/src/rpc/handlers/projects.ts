import {
  cloneFolderOf,
  githubNameOf,
  InvalidState,
  NotFound,
  parseRepoRemote,
  ProjectRpcs,
  type ProjectId,
  type RepoRemote,
} from "@gram/contracts";
import { git, Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cloneRepo, makeCloneSuggestions } from "../../fs/clone.ts";
import { expandHome, registerRepo, repositoryCandidates } from "../../fs/folders.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import {
  folderBringsNothing,
  folderSettings,
  projectFolderTrusted,
} from "../../settings/folder-trust.ts";
import { fileOrigin } from "../../thread-profiles/repositories.ts";
import { githubRelayed } from "../../embedding/github-relay.ts";
import { routeRefusal } from "../../embedding/route-reach.ts";
import {
  projectScriptsDir,
  readProjectScripts,
  saveProjectScripts,
  ScriptsError,
} from "../../scripts/project-scripts.ts";
import { logDefects, type Handlers } from "./common.ts";
import { sessionHandlers } from "./sessions.ts";

/** The GitHub repository a remote names, on github.com; undefined for any other host. */
const githubRepoOf = (remote: RepoRemote): { owner: string; repo: string } | undefined => {
  if (remote.kind === "github") return { owner: remote.owner, repo: remote.repo };
  const [owner, repo, ...rest] = remote.path.replace(/^\/+/, "").split("/");
  return remote.host.toLowerCase() === "github.com" && owner && repo && rest.length === 0
    ? { owner, repo }
    : undefined;
};

/**
 * The URL a headless server files a repository's origin under: a GitHub repository's https
 * address, the spelling a profile's repositories use, so either way it is the same origin.
 */
const originUrl = (remote: RepoRemote): string =>
  remote.kind === "github" ? `https://github.com/${remote.owner}/${remote.repo}` : remote.url;

/**
 * The GitHub `owner/repo` a folder's `origin` names, as its config stores it (not as `insteadOf`
 * rewrites it); undefined for none, another host, or a config that can't be read.
 */
const githubOriginOf = (root: string) =>
  git(root, ["config", "--get", "remote.origin.url"], { timeoutMs: 2_000 }).pipe(
    Effect.map((out) => {
      const url = out.status === 0 ? out.stdout.trim() : "";
      const remote = url === "" ? undefined : parseRepoRemote(url);
      return remote === undefined || "error" in remote ? undefined : githubNameOf(remote);
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * `projects.list`, `projects.add`, `projects.repositories`, `projects.clone`,
 * `projects.setBookmarked` and `projects.forget`.
 */
const projectHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const proc = yield* Proc;
  const provide = Effect.provideService(Proc, proc);
  const suggestions = makeCloneSuggestions(homedir());
  // Absent in test layers without a data folder: a broken scripts file then just has none.
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  const lastGoodDir = config === undefined ? undefined : projectScriptsDir(config.dataDir);
  const projectOf = (projectId: ProjectId) =>
    store.listProjects.pipe(
      Effect.flatMap((projects) => {
        const project = projects.find((each) => each.id === projectId);
        return project === undefined
          ? Effect.fail(new NotFound({ entity: "project", id: projectId }))
          : Effect.succeed(project);
      }),
    );
  const projectRoot = (projectId: ProjectId) =>
    Effect.map(projectOf(projectId), (project) => project.root);

  return {
    "projects.list": () => store.listProjects,
    "projects.add": ({ root, trust }) =>
      Effect.gen(function* () {
        const { project, created } = yield* registerRepo(store, root);
        // Only a folder this call adds takes the answer: an existing project keeps its own, which
        // changes only through `projects.setFolderTrust`. Without one nothing is kept, so settings
        // the folder gains later are asked about rather than trusted for having been absent.
        if (!created || trust === undefined) return project;
        return yield* store.setProjectFolderTrust(project.id, trust);
      }),
    "projects.folderSettings": ({ root }) =>
      Effect.try({
        try: () => folderSettings(resolve(expandHome(root))),
        catch: () => new NotFound({ entity: "file", id: root }),
      }),
    "projects.setFolderTrust": ({ projectId, trusted }) =>
      store.setProjectFolderTrust(projectId, trusted),
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
        // A headless server runs no work itself and holds no credential for the remote: it files
        // the repository's origin, reaching nothing, and the machine a thread is placed on clones
        // it with its own credentials, as it does a profile's repositories.
        if (config?.headless === true) {
          const parsed = parseRepoRemote(remote);
          if ("error" in parsed) return yield* new InvalidState({ message: parsed.error });
          // Where `gh` reaches GitHub through the deployment's route, a repository it won't reach
          // is refused here, with the route's reason, rather than on the machine much later.
          const github = githubRepoOf(parsed);
          if (github !== undefined && githubRelayed()) {
            const refused = yield* routeRefusal(proc, config.dataDir, github.owner, github.repo);
            if (refused !== undefined)
              return yield* new InvalidState({
                message: `Couldn't add ${github.owner}/${github.repo}: ${refused.message}`,
                ...(refused.help === undefined ? {} : { help: refused.help }),
              });
          }
          const filed = yield* fileOrigin(proc, config.dataDir, originUrl(parsed));
          return yield* store.ensureProject({ root: filed.path, name: filed.name });
        }
        const cloneFolder = cloneFolderOf(yield* store.getSettings);
        return yield* provide(cloneRepo(store, { remote, into, cloneFolder }));
      }),
    "projects.origins": ({ projectIds }) =>
      Effect.gen(function* () {
        const wanted = new Set<string>(projectIds);
        const projects = (yield* store.listProjects).filter((project) => wanted.has(project.id));
        const origins = yield* Effect.forEach(
          projects,
          (project) =>
            provide(githubOriginOf(project.repoRoot ?? project.root)).pipe(
              Effect.map((github) =>
                github === undefined
                  ? { projectId: project.id }
                  : { projectId: project.id, github },
              ),
            ),
          { concurrency: 8 },
        );
        return { origins };
      }),
    "projects.cloneSuggestions": () => provide(suggestions),
    "projects.setBookmarked": ({ projectId, bookmarked }) =>
      store.setProjectBookmarked(projectId, bookmarked),
    "projects.forget": ({ projectId }) => store.forgetProject(projectId),
    "projects.scripts": ({ projectId }) =>
      projectOf(projectId).pipe(
        Effect.flatMap((project) =>
          Effect.promise(async () => {
            const scripts = await readProjectScripts(project.root, projectId, lastGoodDir);
            return projectFolderTrusted(project, folderBringsNothing(project.root))
              ? scripts
              : { ...scripts, untrusted: true as const };
          }),
        ),
      ),
    "projects.saveScripts": ({ projectId, scripts }) =>
      projectRoot(projectId).pipe(
        Effect.flatMap((root) =>
          Effect.tryPromise({
            try: () => saveProjectScripts(root, projectId, scripts, lastGoodDir),
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
