import { InvalidState, NotFound, NotImplemented } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { errorMessage, folderProblem, isNotImplemented } from "./errors";

describe("folderProblem", () => {
  it("names a missing, non-folder or unreadable thread folder", () => {
    expect(folderProblem(new NotFound({ entity: "project", id: "/x" }))).toBe(
      "This thread's folder doesn't exist.",
    );
    expect(folderProblem(new InvalidState({ message: "Not a folder: /x" }))).toBe(
      "This thread's folder isn't a folder.",
    );
    expect(folderProblem(new InvalidState({ message: "Permission denied: /x" }))).toBe(
      "Permission denied: /x",
    );
    expect(folderProblem(new Error("NotFound: FileSystem.access (/Users/j/repo.)"))).toBe(
      "This thread's folder doesn't exist.",
    );
    expect(
      folderProblem(new InvalidState({ message: "This thread's folder no longer exists: /x" })),
    ).toBe("This thread's folder doesn't exist.");
  });

  it("leaves other errors alone", () => {
    expect(folderProblem(new NotFound({ entity: "queueItem", id: "q1" }))).toBeUndefined();
    expect(folderProblem(new InvalidState({ message: "Busy" }))).toBeUndefined();
    expect(folderProblem(new Error("boom"))).toBeUndefined();
  });
});

describe("errorMessage", () => {
  it("turns NotImplemented into a friendly state", () => {
    const error = new NotImplemented({ rpc: "git.prDetail" });
    expect(isNotImplemented(error)).toBe(true);
    expect(errorMessage(error)).toBe("Not available yet");
  });

  it("falls back to the tag when a tagged error has no message", () => {
    expect(errorMessage(new NotFound({ entity: "queueItem", id: "q1" }))).toBe("NotFound");
  });

  it("uses plain error messages", () => {
    expect(isNotImplemented(new Error("boom"))).toBe(false);
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("text")).toBe("text");
  });
});
