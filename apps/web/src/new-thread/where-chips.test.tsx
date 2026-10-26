// @vitest-environment happy-dom
import type { Project } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BASE } from "@/composer/worktree-fields";
import { renderWithApi } from "@/panels/test-utils";

import { WhereChips, type WhereChipsProps } from "./where-chips";

const projects = [{ root: "/code/api" }, { root: "/code/web" }] as Project[];

const api = {
  branches: async () => ({ branches: ["main", "release"], default: "main" }),
  browse: async () => ({ path: "/Users/dev", entries: [] }),
};

const chips = (over: Partial<WhereChipsProps> = {}) => {
  const props: WhereChipsProps = {
    folder: "/code/api",
    projects,
    onPickFolder: vi.fn(),
    onBrowse: vi.fn(),
    repoPath: "/code/api",
    worktree: true,
    onWorktree: vi.fn(),
    base: DEFAULT_BASE,
    onBase: vi.fn(),
    ...over,
  };
  renderWithApi(<WhereChips {...props} />, api as never);
  return props;
};

afterEach(cleanup);

describe("WhereChips", () => {
  it("names the folder and picks a recent project", async () => {
    const props = chips();
    const folder = screen.getByRole("button", { name: "Folder" });
    expect(folder.textContent).toBe("api");
    fireEvent.click(folder);
    fireEvent.click(await screen.findByRole("button", { name: /^web/ }));
    expect(props.onPickFolder).toHaveBeenCalledWith("/code/web");
  });

  it("toggles the worktree and hides the base without one", () => {
    const props = chips({ worktree: false, base: undefined });
    expect(screen.queryByRole("combobox", { name: "Start from" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "worktree" }));
    expect(props.onWorktree).toHaveBeenCalledWith(true);
  });

  it("offers no worktree outside a repository", () => {
    chips({ repoPath: "" });
    expect(screen.queryByRole("checkbox", { name: "worktree" })).toBeNull();
  });

  it("asks for a folder before one resolves", () => {
    chips({ folder: "", repoPath: "" });
    expect(screen.getByRole("button", { name: "Folder" }).textContent).toBe("Choose a folder");
  });
});
