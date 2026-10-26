import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, describe, expect, it } from "vitest";

import { imageMediaType, readImage } from "./images.ts";

const dir = mkdtempSync(join(tmpdir(), "gram-images-"));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
writeFileSync(join(dir, "logo.png"), PNG);
writeFileSync(
  join(dir, "icon.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
writeFileSync(join(dir, "notes.txt"), "not an image");
mkdirSync(join(dir, "folder.png"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const failure = async (effect: ReturnType<typeof readImage>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return JSON.stringify(exit.cause);
};

describe("readImage", () => {
  it("serves known image types as base64", async () => {
    const image = await Effect.runPromise(readImage(join(dir, "logo.png"), 1024));
    expect(image).toMatchObject({ mediaType: "image/png", size: PNG.length, tooLarge: false });
    expect(Buffer.from(image.base64!, "base64").equals(PNG)).toBe(true);
    await expect(Effect.runPromise(readImage(join(dir, "icon.svg"), 1024))).resolves.toMatchObject({
      mediaType: "image/svg+xml",
    });
  });

  it("flags oversized images without bytes", async () => {
    const image = await Effect.runPromise(readImage(join(dir, "logo.png"), 4));
    expect(image).toEqual({
      path: join(dir, "logo.png"),
      mediaType: "image/png",
      size: PNG.length,
      tooLarge: true,
    });
  });

  it("refuses non-images, folders and missing files", async () => {
    expect(await failure(readImage(join(dir, "notes.txt"), 1024))).toContain(
      "Not a previewable image",
    );
    expect(await failure(readImage(join(dir, "folder.png"), 1024))).toContain("Is a folder");
    expect(await failure(readImage(join(dir, "gone.png"), 1024))).toContain("File not found");
    expect(imageMediaType("a.JPEG")).toBe("image/jpeg");
  });
});
