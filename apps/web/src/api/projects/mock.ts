import {
  cloneFolderOf,
  GitError,
  notARepositoryMessage,
  parseRepoRemote,
  remoteKey,
  remoteLabel,
} from "@gram/contracts";

import {
  addMockRepo,
  isMockRepo,
  MockInvalidState,
  mockPathExists,
  mockProject,
  mockReposIn,
  resolveMockFolder,
  resolveMockPath,
} from "../mock-fs";
import type { MockWorld } from "../mock-world";
import { mockFolderSettings } from "./mock-folder-settings";
import { mockProjectScripts, saveMockProjectScripts } from "./mock-scripts";
import type { ProjectsApi } from "./types";

/**
 * `ProjectsApi` over the core's projects. The core builds it, because its scenario controls add a
 * repo and hold clones; `api` is what joins the `Api`.
 */
export function createProjectsMock(world: MockWorld) {
  let holdClones = false;
  const clones = new Map<string, string>();
  const find = (match: (project: ReturnType<MockWorld["projects"]>[number]) => boolean) =>
    world.projects().find(match);

  const addProject: ProjectsApi["addProject"] = async (root, options) => {
    const path = resolveMockFolder(root);
    if (!isMockRepo(path)) {
      throw new MockInvalidState(notARepositoryMessage(path));
    }
    const existing = find((p) => p.root === path);
    if (existing) return existing;
    const { lastOpenedAt: _unopened, ...made } = mockProject(path, `p-${world.ids()}`);
    const trust = options?.trust;
    const added =
      trust === undefined
        ? made
        : { ...made, folderTrust: trust ? ("trusted" as const) : ("untrusted" as const) };
    world.updateProjects((projects) => [...projects, added]);
    return added;
  };

  const api: ProjectsApi = {
    listProjects: async () => world.projects(),
    listRepositories: async () => {
      const settings = await world.settings();
      const projects = world.projects();
      const known = projects.filter((p) => isMockRepo(p.root));
      const seen = new Set(projects.map((p) => p.root));
      const found: Array<{ name: string; root: string }> = [];
      for (const folder of [settings.agents.defaultFolder, cloneFolderOf(settings)]) {
        if (folder === undefined || folder.trim() === "") continue;
        for (const root of mockReposIn(folder)) {
          if (seen.has(root)) continue;
          seen.add(root);
          found.push({ name: root.slice(root.lastIndexOf("/") + 1), root });
        }
      }
      return {
        repos: [
          ...known.map((p) => ({ name: p.name, root: p.root, projectId: p.id })),
          ...found.toSorted((a, b) => a.name.localeCompare(b.name)),
        ],
      };
    },
    addProject,
    cloneProject: async (remoteText, options) => {
      const remote = parseRepoRemote(remoteText);
      if ("error" in remote) throw new MockInvalidState(remote.error);
      const label = remoteLabel(remote);
      const folder = options?.into ?? cloneFolderOf(await world.settings());
      const target = resolveMockPath(`${folder}/${remote.repo}`);
      await world.delay(1000);
      if (holdClones) await world.gate("clone");
      options?.signal?.throwIfAborted();
      if (isMockRepo(target) && clones.get(target) === remoteKey(remote)) {
        return addProject(target);
      }
      if (mockPathExists(target)) {
        throw new MockInvalidState(
          `${target} already exists and isn't a clone of ${label}. Move it, or change where new clones go in Settings → General.`,
        );
      }
      if (remote.repo === "missing") {
        throw new GitError({
          message: `Couldn't clone ${label}: GraphQL: Could not resolve to a Repository with the name '${label}'.`,
        });
      }
      addMockRepo(target);
      clones.set(target, remoteKey(remote));
      return addProject(target);
    },
    projectOrigins: async (projectIds) => ({
      origins: world.projects().flatMap((project) => {
        if (!projectIds.includes(project.id)) return [];
        const cloned = clones.get(project.root);
        const github =
          cloned === undefined
            ? isMockRepo(project.root)
              ? `EXAMPLE/${project.name}`
              : undefined
            : cloned.startsWith("github.com/")
              ? cloned.slice("github.com/".length)
              : undefined;
        return [
          github === undefined ? { projectId: project.id } : { projectId: project.id, github },
        ];
      }),
    }),
    cloneSuggestions: async () => ({
      repos: [
        "EXAMPLE/example-device-apps",
        "ANT1OFF/gram",
        "EXAMPLE/agent-factory",
        "EXAMPLE/example-infra",
      ],
    }),
    folderSettings: async (root) => {
      await world.delay(40);
      return mockFolderSettings(resolveMockFolder(root));
    },
    setFolderTrust: async (projectId, trusted) => {
      const project = find((p) => p.id === projectId);
      if (!project) throw new Error("That project no longer exists.");
      const next = {
        ...project,
        folderTrust: trusted ? ("trusted" as const) : ("untrusted" as const),
      };
      world.updateProjects((projects) => projects.map((p) => (p.id === projectId ? next : p)));
      return next;
    },
    setProjectBookmarked: async (projectId, bookmarked) => {
      const project = find((p) => p.id === projectId);
      if (!project) throw new Error("That project no longer exists.");
      const next = { ...project, bookmarked };
      world.updateProjects((projects) => projects.map((p) => (p.id === projectId ? next : p)));
      return next;
    },
    projectScripts: async (projectId) => {
      await world.delay(40);
      return mockProjectScripts(world, projectId);
    },
    saveProjectScripts: async (projectId, scripts) => {
      await world.delay(60);
      return saveMockProjectScripts(world, projectId, scripts);
    },
    forgetProject: async (projectId) => {
      const project = find((p) => p.id === projectId);
      if (!project) throw new Error("That project no longer exists.");
      if (world.threads().some(({ thread }) => thread.projectId === projectId)) {
        throw new Error(`Close the threads in ${project.name} before removing it from recents.`);
      }
      world.updateProjects((projects) => projects.filter((p) => p.id !== projectId));
    },
  };
  return {
    api,
    /** Holds every clone until `release("clone")`, so a spec can see one under way. */
    holdClones: () => {
      holdClones = true;
    },
  };
}
