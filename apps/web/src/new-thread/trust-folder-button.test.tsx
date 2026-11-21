// @vitest-environment happy-dom
import type { FolderSettings, Project, ProjectId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { TrustFolderButton } from "./trust-folder-button";

afterEach(cleanup);

const settings = (other: ReadonlyArray<string>): FolderSettings => ({
  hooks: [],
  mcpServers: [],
  allowRules: 0,
  env: [],
  commands: [],
  scripts: [],
  unreadable: [],
  other,
  none: other.length === 0,
});

const project = (folderTrust?: "trusted" | "untrusted"): Project => ({
  id: "p1" as ProjectId,
  root: "/code/app",
  name: "app",
  bookmarked: false,
  ...(folderTrust === undefined ? {} : { folderTrust }),
});

const render = (of: Project, brings: ReadonlyArray<string>) => {
  const setFolderTrust = vi.fn(async (_id: ProjectId, trusted: boolean) => ({
    ...of,
    folderTrust: trusted ? ("trusted" as const) : ("untrusted" as const),
  }));
  renderWithApi(<TrustFolderButton project={of} />, {
    folderSettings: async () => settings(brings),
    setFolderTrust,
  });
  return setFolderTrust;
};

describe("TrustFolderButton", () => {
  it("asks once by itself for a folder never asked about that brings something", async () => {
    const setFolderTrust = render(project(), [".claude/skills"]);
    expect(await screen.findByText(".claude/skills")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    // Closing it records the answer, so it isn't asked unprompted again.
    await waitFor(() => expect(setFolderTrust).toHaveBeenCalledWith("p1", false));
  });

  it("only offers the question for a folder already answered", async () => {
    const setFolderTrust = render(project("untrusted"), [".claude/skills"]);
    expect(await screen.findByRole("button", { name: "app isn't trusted" })).toBeTruthy();
    expect(screen.queryByText(".claude/skills")).toBeNull();
    expect(setFolderTrust).not.toHaveBeenCalled();
  });
});
