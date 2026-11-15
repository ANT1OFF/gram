// @vitest-environment happy-dom
import type { Project, ProjectId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";

import { AlsoRepositories } from "./also-repositories";

afterEach(cleanup);

const CLONES = "/home/me/clones/github.com/acme";
const project = (root: string): Project => ({
  id: root as ProjectId,
  root,
  name: root.split("/").at(-1)!,
  repoRoot: root,
  bookmarked: false,
  lastOpenedAt: 1,
});
const api = `${CLONES}/api+61a386c7374a4745`;
const web = `${CLONES}/web+0123456789abcdef`;

function Harness({ onChange }: { onChange: (roots: readonly string[]) => void }) {
  const [roots, setRoots] = useState<readonly string[]>([]);
  return (
    <AlsoRepositories
      primary={api}
      roots={roots}
      projects={[project(api), project(web)]}
      onChange={(next) => {
        setRoots(next);
        onChange(next);
      }}
    />
  );
}

describe("AlsoRepositories", () => {
  it("offers the other repositories here by owner and name, and clones one typed", async () => {
    const mock = createMockApi({ speed: 0, autoplay: false, persist: false });
    const cloned = project(`${CLONES}/docs+fedcba9876543210`);
    const clone = vi.spyOn(mock, "cloneProject").mockResolvedValue(cloned);
    vi.spyOn(mock, "cloneSuggestions").mockResolvedValue({ repos: [] });
    const onChange = vi.fn();
    renderWithApi(<Harness onChange={onChange} />, mock);

    fireEvent.click(screen.getByTestId("also-repositories-add"));
    // The one it works in is never offered; the other is, as owner/name.
    expect(await screen.findByRole("button", { name: "acme/web" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "acme/api" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "acme/web" }));
    expect(onChange).toHaveBeenLastCalledWith([web]);
    expect(screen.getByText("acme/web")).toBeTruthy();

    fireEvent.click(screen.getByTestId("also-repositories-add"));
    fireEvent.change(await screen.findByPlaceholderText("Search, or type owner/name"), {
      target: { value: "acme/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clone acme/docs" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([web, cloned.root]));
    expect(clone).toHaveBeenCalledWith("acme/docs");

    fireEvent.click(screen.getByRole("button", { name: "Don't use acme/web" }));
    expect(onChange).toHaveBeenLastCalledWith([cloned.root]);
  });
});
