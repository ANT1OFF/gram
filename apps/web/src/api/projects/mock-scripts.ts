import {
  type ProjectId,
  type ProjectScript,
  type ProjectScripts,
  SCRIPTS_FILE,
  scriptSuggestions,
  validateScripts,
} from "@gram/contracts";

import { readMockFile } from "../mock-files";
import { MockInvalidState } from "../mock-fs";
import type { MockWorld } from "../mock-world";

/** Each mock world's saved scripts, by project: what `.gram/scripts.json` holds on the server. */
const saved = new WeakMap<MockWorld, Map<ProjectId, ProjectScript[]>>();

const scriptsOf = (world: MockWorld) => {
  let map = saved.get(world);
  if (map === undefined) {
    map = new Map();
    saved.set(world, map);
  }
  return map;
};

const fileText = (path: string): string | undefined => {
  try {
    const file = readMockFile(path);
    return file.binary || file.tooLarge ? undefined : file.content;
  } catch {
    return undefined;
  }
};

const rootOf = (world: MockWorld, projectId: ProjectId): string => {
  const project = world.projects().find((p) => p.id === projectId);
  if (project === undefined)
    throw Object.assign(new Error("That project no longer exists."), { _tag: "NotFound" });
  return project.root;
};

/** `projects.scripts` over the mock's files: the seeded `package.json` gives the suggestions. */
export function mockProjectScripts(world: MockWorld, projectId: ProjectId): ProjectScripts {
  const root = rootOf(world, projectId);
  const scripts = scriptsOf(world).get(projectId) ?? [];
  return {
    projectId,
    file: SCRIPTS_FILE,
    scripts,
    suggestions: scriptSuggestions(
      {
        packageJson: fileText(`${root}/package.json`),
        makefile: fileText(`${root}/Makefile`),
      },
      scripts,
    ),
  };
}

export function saveMockProjectScripts(
  world: MockWorld,
  projectId: ProjectId,
  scripts: readonly ProjectScript[],
): ProjectScripts {
  rootOf(world, projectId);
  const checked = validateScripts(scripts);
  if ("error" in checked) throw new MockInvalidState(checked.error);
  scriptsOf(world).set(projectId, checked.scripts);
  return mockProjectScripts(world, projectId);
}

/** The saved script `name` of the project, as `terminal.open`'s `script` resolves it. */
export function mockScript(
  world: MockWorld,
  projectId: ProjectId,
  name: string,
): ProjectScript | undefined {
  return scriptsOf(world)
    .get(projectId)
    ?.find((script) => script.name === name);
}
