// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { ArtifactCard } from "./artifact-card";

const T = "t-artifact" as ThreadId;
const URL = "https://claude.ai/code/artifact/11111111-1111-4111-8111-111111111111";

const { previewFile } = useLayoutStore.getState();

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ previewFile });
});

describe("ArtifactCard", () => {
  it("shows the published page's file here and opens the page on claude.ai", () => {
    const shown = vi.fn();
    useLayoutStore.setState({ previewFile: shown });
    renderWithApi(
      <ArtifactCard
        threadId={T}
        artifact={{
          url: URL,
          title: "Checkout mock",
          version: "2",
          source: { path: "/tmp/scratch/checkout.html", kind: "html" },
        }}
      />,
      {},
    );

    expect(screen.getByTestId("artifact-card").textContent).toContain("Artifact on claude.ai · v2");
    fireEvent.click(screen.getByRole("button", { name: "Show Checkout mock" }));
    expect(shown).toHaveBeenCalledWith(T, "/tmp/scratch/checkout.html", {
      previewPane: expect.any(Boolean),
    });
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(URL);
  });

  it("offers only Open when there is no file to show", () => {
    renderWithApi(<ArtifactCard threadId={T} artifact={{ url: URL }} />, {});
    expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open" })).toBeTruthy();
  });
});
