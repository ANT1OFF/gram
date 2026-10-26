// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { domMax, LazyMotion } from "motion/react";

import { themeStore } from "@/theme/store";

import { AttachmentChips } from "./attachment-chips";

afterEach(cleanup);

const readyChip = (key: string) => ({ key, name: `${key}.md`, status: "ready" as const });

describe("AttachmentChips", () => {
  it("renders nothing without attachments", () => {
    const { container } = render(<AttachmentChips items={[]} onRemove={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows each chip's status, thumbnail and path, and removes one", async () => {
    const onRemove = vi.fn();
    render(
      <AttachmentChips
        items={[
          { key: "a", name: "shot.png", status: "uploading", previewUrl: "blob:shot" },
          {
            key: "b",
            name: "notes.md",
            status: "ready",
            attachment: { path: "/data/attachments/_drafts/d/1a2b-notes.md", name: "notes.md" },
          },
          { key: "c", name: "setup.exe", status: "failed", error: "only images and text files" },
        ]}
        onRemove={onRemove}
      />,
    );

    const chips = screen.getAllByTestId("attachment-chip");
    expect(chips.map((chip) => chip.dataset["status"])).toEqual(["uploading", "ready", "failed"]);
    expect(chips[0]?.querySelector("img")?.getAttribute("src")).toBe("blob:shot");
    expect(screen.getByLabelText("Uploading")).toBeTruthy();
    expect(chips[1]?.getAttribute("title")).toBe("/data/attachments/_drafts/d/1a2b-notes.md");
    expect(chips[2]?.getAttribute("title")).toBe("only images and text files");

    await userEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("takes a removed chip away at once when motion is off, and leaves the rest", async () => {
    themeStore.setState({ motion: "off" });
    try {
      const { rerender } = render(
        <AttachmentChips items={[readyChip("a"), readyChip("b")]} onRemove={() => {}} />,
      );
      rerender(<AttachmentChips items={[readyChip("b")]} onRemove={() => {}} />);
      await waitFor(() => expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1));
      expect(screen.getByTestId("attachment-chip").textContent).toContain("b.md");
    } finally {
      themeStore.setState({ motion: themeStore.getInitialState().motion });
    }
  });

  it("makes a leaving chip inert, so a click meant for the next can't remove it again", () => {
    themeStore.setState({ motion: "system" });
    try {
      const chips = (keys: string[]) => (
        <LazyMotion features={domMax}>
          <AttachmentChips items={keys.map(readyChip)} onRemove={() => {}} />
        </LazyMotion>
      );
      const { rerender } = render(chips(["a", "b"]));
      const leaving = screen.getByRole("button", { name: "Remove a.md" }).closest("li")!;
      expect(leaving.inert).toBe(false);
      rerender(chips(["b"]));
      expect(leaving.isConnected).toBe(true);
      expect(leaving.inert).toBe(true);
    } finally {
      themeStore.setState({ motion: themeStore.getInitialState().motion });
    }
  });
});
