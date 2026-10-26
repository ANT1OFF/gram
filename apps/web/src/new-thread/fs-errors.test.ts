import { describe, expect, it } from "vitest";

import { MockInvalidState, MockNotFound } from "@/api/mock-fs";

import { folderProblem } from "./fs-errors";

describe("folderProblem", () => {
  it("explains a worktree on a folder that isn't a git repository", () => {
    const problem = folderProblem({
      _tag: "GitError",
      message: "repoPath is not a git repository",
    });
    expect(problem.message).toContain("isn't a git repository");
    expect(problem.message).toContain("Current checkout");
  });

  it("prefers the server's message", () => {
    expect(folderProblem(new MockNotFound("/x"))).toEqual({
      kind: "notFound",
      message: "Folder not found: /x",
    });
    expect(folderProblem(new MockInvalidState("Not a folder: /x/README.md"))).toEqual({
      kind: "notADirectory",
      message: "Not a folder: /x/README.md",
    });
    const denied = "Gram can't read /x. Allow it in … Files & Folders.";
    expect(folderProblem(new MockInvalidState(denied))).toEqual({
      kind: "permissionDenied",
      message: denied,
    });
  });

  it("names the folder when NotFound has no message", () => {
    expect(folderProblem({ _tag: "NotFound", entity: "project", id: "~/code/x" }).message).toBe(
      "Folder not found: ~/code/x",
    );
    expect(folderProblem({ _tag: "NotFound", entity: "label", id: "l-1" }).kind).toBe("other");
  });

  it("covers unimplemented and unexpected errors", () => {
    expect(folderProblem({ _tag: "NotImplemented" }).kind).toBe("unavailable");
    expect(folderProblem(new Error("disk on fire"))).toEqual({
      kind: "other",
      message: "disk on fire",
    });
  });
});
