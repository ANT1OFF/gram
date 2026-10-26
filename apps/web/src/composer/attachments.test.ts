import { MAX_ATTACHMENT_BYTES, type ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { attachFile, toBase64 } from "./attachments";

const target = { threadId: "t1" as ThreadId };

describe("toBase64", () => {
  it("matches Node's encoding across slice boundaries", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("attachFile", () => {
  it("uses the desktop shell's path without uploading", async () => {
    const uploadAttachment = vi.fn();
    const file = new File(["x"], "notes.md", { type: "text/markdown" });
    await expect(
      attachFile({ uploadAttachment }, target, file, () => "/Users/x/notes.md"),
    ).resolves.toEqual({ path: "/Users/x/notes.md", name: "notes.md", mediaType: "text/markdown" });
    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads a pathless file's bytes", async () => {
    const stored = { path: "/data/attachments/t1/1a2b3c4d-image.png", name: "image.png" };
    const uploadAttachment = vi.fn(async () => stored);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    await expect(attachFile({ uploadAttachment }, target, file)).resolves.toBe(stored);
    expect(uploadAttachment).toHaveBeenCalledWith(target, {
      name: "image.png",
      mediaType: "image/png",
      data: "iVBORw==",
    });
  });

  it("rejects a file over the limit before reading it", async () => {
    const uploadAttachment = vi.fn();
    const file = { name: "huge.png", type: "image/png", size: MAX_ATTACHMENT_BYTES + 1 } as File;
    await expect(attachFile({ uploadAttachment }, target, file)).rejects.toThrow(
      "attachment limit",
    );
    expect(uploadAttachment).not.toHaveBeenCalled();
  });
});
