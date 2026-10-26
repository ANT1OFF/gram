import { describe, expect, it } from "vitest";
import type { Project, ProjectId } from "@gram/contracts";
import { checklistRows } from "./repository-checklist";

const project: Project = {
  id: "p-infra" as ProjectId,
  name: "infra",
  root: "/synthetic/infra",
  bookmarked: false,
};

describe("repository checklist registration", () => {
  it("reconciles a stale discovered folder with its newly registered selected project", () => {
    const rows = checklistRows([{ name: "infra", root: project.root }], [project], [project.id]);
    expect(rows).toEqual([{ name: "infra", root: project.root, projectId: project.id }]);
  });

  it("retains a picked project absent from discovery without duplicating known candidates", () => {
    const known = { name: "api", root: "/synthetic/api", projectId: "p-api" as ProjectId };
    expect(checklistRows([known], [project], [project.id])).toEqual([
      { name: "infra", root: project.root, projectId: project.id },
      known,
    ]);
  });
});
