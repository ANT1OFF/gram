// Behind a GitHub route, a routine's look reads a repository by name only while it is a project of
// its workspace, checked at every run, not only when the routine was made.
import { describe, expect, it } from "@effect/vitest";
import { parseRoutineTrigger } from "@gram/contracts";
import { outsideWorkspace } from "./events.ts";

const on = (text: string) => {
  const parsed = parseRoutineTrigger(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.on;
};

describe("a routine's look behind a GitHub route", () => {
  it("reads only a repository of its workspace's projects", () => {
    const repos = { workspaceRepos: ["acme/app"] };
    expect(outsideWorkspace(on("release github someone/private"), repos, true)).toContain(
      "someone/private",
    );
    expect(outsideWorkspace(on("review requested someone/private"), repos, true)).toContain(
      "someone/private",
    );
    expect(outsideWorkspace(on("release github Acme/App"), repos, true)).toBeUndefined();
    // A project gone from the workspace: its repository with it.
    expect(outsideWorkspace(on("release github acme/app"), { workspaceRepos: [] }, true)).toContain(
      "acme/app",
    );
    // Without a route, a person's own `gh` reads what they can see.
    expect(outsideWorkspace(on("release github someone/private"), repos, false)).toBeUndefined();
  });
});
