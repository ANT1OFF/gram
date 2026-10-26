// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CompactionMarker } from "./compaction-marker";

afterEach(cleanup);

describe("compaction details", () => {
  it("opens metadata and an honest fallback for a marker without a supplied summary", async () => {
    render(<CompactionMarker compaction={{ trigger: "auto", preTokens: 42 }} />);
    const toggle = screen.getByRole("button", { name: "Context compacted · from 42 tokens" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("compaction-details")).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const details = screen.getByTestId("compaction-details");
    expect(details.textContent).toContain("Automatic compaction");
    expect(details.textContent).toContain("Summary not provided");
    expect(details.textContent).toContain("was not supplied by the agent or saved in this history");
    expect(screen.queryByTestId("compaction-summary")).toBeNull();
  });

  it("opens and closes with the keyboard and describes the action", async () => {
    render(
      <CompactionMarker compaction={{ trigger: "manual", summary: "Preserve the retry fix." }} />,
    );
    const toggle = screen.getByRole("button", { name: "Context compacted" });
    await userEvent.tab();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("title")).toContain("Show compaction details");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("compaction-summary").textContent).toBe("Preserve the retry fix.");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("title")).toContain("Hide compaction details");
    await userEvent.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps provider text literal and preserves it on remount, with blank summaries unavailable", async () => {
    const summary = "1. **Intent**\n<script>alert('unsafe')</script>\nKeep `retry()` unchanged.";
    const data = { trigger: "manual", summary } as const;
    const first = render(<CompactionMarker compaction={data} />);
    await userEvent.click(screen.getByRole("button", { name: "Context compacted" }));
    expect(screen.getByTestId("compaction-summary").textContent).toBe(summary);
    expect(screen.getByTestId("compaction-summary").querySelector("script")).toBeNull();
    first.unmount();
    const restored = JSON.parse(JSON.stringify(data));
    const second = render(<CompactionMarker compaction={restored} />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("compaction-summary").textContent).toBe(summary);
    second.rerender(<CompactionMarker compaction={{ trigger: "manual", summary: " \n " }} />);
    expect(screen.getByTestId("compaction-details").textContent).toContain("Summary not provided");
    expect(screen.queryByTestId("compaction-summary")).toBeNull();
  });

  it("replaces the unavailable fallback when a late provider summary updates the same marker", async () => {
    const view = render(<CompactionMarker compaction={{ trigger: "manual" }} />);
    await userEvent.click(screen.getByRole("button"));
    view.rerender(
      <CompactionMarker compaction={{ trigger: "manual", summary: "The retained result." }} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("compaction-summary").textContent).toBe("The retained result.");
    expect(screen.getByTestId("compaction-details").textContent).not.toContain(
      "Summary not provided",
    );
  });
});
