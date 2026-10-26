// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockPrDetail } from "@/api/mock-git";

import { PrLabels } from "./pr-labels";
import { renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;
const detail = mockPrDetail(T).detail!;

const repoLabels = {
  labels: [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "flaky", color: "fbca04", description: "" },
    { name: "needs review", color: "zzz", description: "" },
  ],
};

afterEach(cleanup);

describe("PrLabels", () => {
  it("shows the PR's labels as named chips and removes one", async () => {
    const prLabelsRemove = vi.fn(async () => {});
    renderWithApi(<PrLabels threadId={T} detail={detail} />, { prLabelsRemove });
    const chips = within(screen.getByRole("list", { name: "Labels" })).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual(["tests", "flaky"]);
    expect(chips[0]!.getAttribute("title")).toBe("Test-only changes");

    fireEvent.click(screen.getByRole("button", { name: "Remove label flaky" }));
    expect((await screen.findByRole("status")).textContent).toBe("Removed flaky");
    expect(prLabelsRemove).toHaveBeenCalledWith(T, ["flaky"]);
  });

  it("adds one of the repository's labels that the PR doesn't have yet", async () => {
    const prLabelsList = vi.fn(async () => repoLabels);
    const prLabelsAdd = vi.fn(async () => {});
    renderWithApi(<PrLabels threadId={T} detail={detail} />, { prLabelsList, prLabelsAdd });

    fireEvent.click(screen.getByRole("button", { name: "Add label…" }));
    const options = await screen.findByRole("list", { name: "Repository labels" });
    expect(
      within(options)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["bug", "needs review"]);

    fireEvent.change(screen.getByLabelText("Filter repository labels"), {
      target: { value: "need" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Add label" }));
    await waitFor(() => expect(prLabelsAdd).toHaveBeenCalledWith(T, ["needs review"]));
    expect((await screen.findByRole("status")).textContent).toBe("Added needs review");
    expect(screen.queryByLabelText("Filter repository labels")).toBeNull();
  });

  it("explains when the repository's labels can't be read", async () => {
    renderWithApi(<PrLabels threadId={T} detail={detail} />, {
      prLabelsList: vi.fn(async () => {
        throw new Error("HTTP 404: Not Found");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Add label…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("HTTP 404");
  });

  it("returns focus to Add label… when the form is cancelled", async () => {
    renderWithApi(<PrLabels threadId={T} detail={detail} />, {
      prLabelsList: vi.fn(async () => repoLabels),
    });
    fireEvent.click(screen.getByRole("button", { name: "Add label…" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add label…" })),
    );
  });
});
