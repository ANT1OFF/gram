// @vitest-environment happy-dom
import type { Attachment, DraftId } from "@gram/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";

import { useAttachments } from "./use-attachments";

afterEach(cleanup);

const draftId = "5a9b6bc9-01d5-4fb3-aacf-ec410b8b74d5" as DraftId;

const noop = () => {};

const files = (...list: File[]) =>
  Object.assign([...list], { item: (i: number) => list[i] }) as unknown as FileList;

const setup = (uploadAttachment: Api["uploadAttachment"]) => {
  const api = { uploadAttachment } as unknown as Api;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>{children}</ApiProvider>
  );
  return renderHook(() => useAttachments({ draftId }), { wrapper });
};

describe("useAttachments", () => {
  it("uploads to the draft, blocks while uploading and hands over what's ready", async () => {
    let finish: (attachment: Attachment) => void = noop;
    const uploadAttachment = vi.fn(() => new Promise<Attachment>((resolve) => (finish = resolve)));
    const { result } = setup(uploadAttachment);

    act(
      () =>
        void result.current.add(
          files(new File(["# notes"], "notes.md", { type: "text/markdown" })),
        ),
    );
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect(uploadAttachment).toHaveBeenCalledWith(
      { draftId },
      expect.objectContaining({ name: "notes.md", mediaType: "text/markdown" }),
    );
    expect(result.current.uploading).toBe(true);
    expect(result.current.ready).toEqual([]);

    const stored = { path: `/data/attachments/_drafts/${draftId}/1a2b-notes.md`, name: "notes.md" };
    act(() => finish(stored));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    expect(result.current.ready).toEqual([stored]);

    act(() => result.current.clear());
    expect(result.current.items).toEqual([]);
  });

  it("marks a rejected upload as failed, with the reason, and lets it be removed", async () => {
    const uploadAttachment = vi.fn(async () => {
      throw new Error("Can't attach setup.exe: only images and text files");
    });
    const { result } = setup(uploadAttachment);

    act(() => void result.current.add(files(new File(["x"], "setup.exe"))));
    await waitFor(() => expect(result.current.items[0]?.status).toBe("failed"));
    expect(result.current.items[0]?.error).toContain("only images and text files");
    expect(result.current.uploading).toBe(false);

    act(() => result.current.remove(result.current.items[0]!.key));
    expect(result.current.items).toEqual([]);
  });

  it("adopts stored attachments as ready chips, without uploading them again", () => {
    const uploadAttachment = vi.fn();
    const { result } = setup(uploadAttachment);
    const restored = [
      { path: "/data/attachments/t-stash/1a2b-shot.png", name: "shot.png", mediaType: "image/png" },
      { path: "/Users/me/notes.md", name: "notes.md" },
    ];

    act(() => result.current.adopt(restored));

    expect(result.current.items.map((item) => [item.name, item.status])).toEqual([
      ["shot.png", "ready"],
      ["notes.md", "ready"],
    ]);
    expect(result.current.ready).toEqual(restored);
    expect(result.current.uploading).toBe(false);
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("reports that there was nothing to attach", () => {
    const { result } = setup(vi.fn());
    let added = true;
    act(() => {
      added = result.current.add(files());
    });
    expect(added).toBe(false);
  });
});
