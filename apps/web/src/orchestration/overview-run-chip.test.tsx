// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { WorkerRunChip } from "./overview-run-chip";

afterEach(cleanup);

describe("WorkerRunChip", () => {
  it("draws nothing for no runs", () => {
    renderWithApi(<WorkerRunChip runs={[]} />, {});
    expect(screen.queryByTestId("overview-run-chip")).toBeNull();
  });

  it("opens the run it watches on GitHub", async () => {
    const openExternal = vi.fn(async () => {});
    renderWithApi(
      <WorkerRunChip
        runs={[
          {
            repo: "acme/app",
            runId: 4411,
            name: "Application checks",
            url: "https://github.com/acme/app/actions/runs/4411",
          },
        ]}
      />,
      { openExternal },
    );
    const chip = screen.getByTestId("overview-run-chip");
    expect(chip.getAttribute("aria-label")).toBe(
      "Watching a workflow run: Application checks (acme/app #4411), running",
    );
    fireEvent.click(chip);
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/app/actions/runs/4411"),
    );
  });

  it("holds its room unseen as a ghost, with no control of its own", () => {
    renderWithApi(<WorkerRunChip runs={[{ repo: "acme/app", runId: 1 }]} ghost />, {});
    expect(screen.queryByTestId("overview-run-chip")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
