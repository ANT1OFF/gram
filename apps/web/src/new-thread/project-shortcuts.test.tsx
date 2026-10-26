// @vitest-environment happy-dom
import { useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useApi } from "@/api/context";
import { createMockApi } from "@/api/mock";
import { PROJECTS } from "@/api/mock-scripts";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { ProjectShortcuts } from "./project-shortcuts";

function Harness() {
  const api = useApi();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  return (
    <ProjectShortcuts
      projects={projects}
      current={undefined}
      defaultFolder={undefined}
      onChoose={() => undefined}
      onBrowse={() => undefined}
    />
  );
}

afterEach(cleanup);

describe("ProjectShortcuts bookmarks", () => {
  it("bookmarks a recent project into Bookmarks and removes it again", async () => {
    renderWithApi(<Harness />, createMockApi({ speed: 0, autoplay: false }));
    const bookmarks = await screen.findByRole("region", { name: "Bookmarks" });
    await within(bookmarks).findByRole("button", { name: "Remove bookmark from api" });
    expect(within(bookmarks).queryByRole("button", { name: /web/ })).toBeNull();

    const recent = screen.getByRole("region", { name: "Recent" });
    const toggle = within(recent).getByRole("button", { name: "Bookmark web" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);

    const remove = await within(bookmarks).findByRole("button", {
      name: "Remove bookmark from web",
    });
    expect(remove.getAttribute("aria-pressed")).toBe("true");
    // A bookmark is listed once: Recent leaves it out while it is bookmarked.
    expect(within(recent).queryByRole("button", { name: /web/ })).toBeNull();
    expect(within(recent).queryByRole("button", { name: /api/ })).toBeNull();
    fireEvent.click(remove);
    await waitFor(() =>
      expect(within(bookmarks).queryByRole("button", { name: /web/ })).toBeNull(),
    );
    await within(recent).findByRole("button", { name: "Bookmark web" });
  });
});

describe("ProjectShortcuts recents", () => {
  afterEach(() => useThreadDialogs.setState({ error: undefined }));

  it("removes a project from Recent, and says why the server refused another", async () => {
    let projects = [...PROJECTS];
    const forgetProject = vi.fn(async (projectId: string) => {
      if (projectId === "p-web") {
        throw new Error("Close the threads in web before removing it from recents.");
      }
      projects = projects.filter((p) => p.id !== projectId);
    });
    renderWithApi(<Harness />, {
      listProjects: async () => projects,
      setProjectBookmarked: vi.fn(),
      forgetProject,
    });
    const recent = screen.getByRole("region", { name: "Recent" });

    fireEvent.click(
      await within(recent).findByRole("button", { name: "Remove docs from recents" }),
    );
    await waitFor(() =>
      expect(within(recent).queryByRole("button", { name: "Remove docs from recents" })).toBeNull(),
    );
    expect(forgetProject).toHaveBeenCalledWith("p-docs");

    fireEvent.click(within(recent).getByRole("button", { name: "Remove web from recents" }));
    await waitFor(() =>
      expect(useThreadDialogs.getState().error).toBe(
        "Couldn't remove web from recents: Close the threads in web before removing it from recents.",
      ),
    );
    expect(within(recent).getByRole("button", { name: "Remove web from recents" })).toBeTruthy();
  });

  it("has no Bookmarks section until a project is bookmarked", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    vi.spyOn(api, "listProjects").mockResolvedValue(
      PROJECTS.map((project) => ({ ...project, bookmarked: false })),
    );
    renderWithApi(<Harness />, api);
    const recent = screen.getByRole("region", { name: "Recent" });
    await within(recent).findByRole("button", { name: "Bookmark web" });
    expect(screen.queryByRole("region", { name: "Bookmarks" })).toBeNull();
    expect(screen.queryByText(/No bookmarked/)).toBeNull();
  });

  it("offers removal on Recent rows only", async () => {
    renderWithApi(<Harness />, createMockApi({ speed: 0, autoplay: false }));
    const bookmarks = await screen.findByRole("region", { name: "Bookmarks" });
    await within(bookmarks).findByRole("button", { name: "Remove bookmark from api" });
    expect(within(bookmarks).queryByRole("button", { name: /from recents/ })).toBeNull();
  });
});
