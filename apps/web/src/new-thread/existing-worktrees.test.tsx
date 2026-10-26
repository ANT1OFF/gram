// @vitest-environment happy-dom
import { DEFAULT_SETTINGS } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { NewThreadDraft } from "@/composer/new-thread-draft";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { ExistingWorktrees } from "./existing-worktrees";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

describe("ExistingWorktrees", () => {
  it("lists worktrees, disables open ones and picks a path", async () => {
    const onChange = vi.fn();
    renderWithApi(
      <ExistingWorktrees repoPath="/Users/dev/code/api" value="" onChange={onChange} />,
      createMockApi({ speed: 0, autoplay: false }),
    );

    const group = await screen.findByRole("radiogroup", { name: "Existing worktrees" });
    const cache = within(group).getByRole("radio", { name: /experiment\/cache/ });
    const flaky = within(group).getByRole("radio", { name: /fix\/flaky-retry/ });
    expect(flaky.hasAttribute("disabled")).toBe(true);
    expect(flaky.textContent).toContain("open in a thread");
    expect(within(group).queryByRole("radio", { name: /^main/ })).toBeNull();

    fireEvent.click(cache);
    expect(onChange).toHaveBeenCalledWith("/Users/dev/code/api/.worktrees/cache-experiment");
  });
});

describe("NewThreadDraft", () => {
  it("starts from the default folder when one is set", async () => {
    useServerSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, defaultFolder: "~/Documents/code" },
      },
    });
    renderWithApi(<NewThreadDraft />, createMockApi({ speed: 0, autoplay: false }));
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>("combobox", { name: "Project path" }).value).toBe(
        "~/Documents/code",
      ),
    );
  });
});
