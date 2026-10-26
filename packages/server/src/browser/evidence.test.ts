import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EvidencePathError, writeEvidence } from "./evidence.ts";

const fixture = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gram-evidence-")));
  const root = join(base, "checkout");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
};
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

describe("writeEvidence", () => {
  it("writes inside the checkout, making the folders, relative or absolute", async () => {
    const { root } = fixture();
    const written = await writeEvidence(root, "docs/verification/x/after.png", PNG, ".png");
    expect(written).toBe(join(root, "docs/verification/x/after.png"));
    expect([...readFileSync(written)]).toEqual([...PNG]);
    // Overwriting a file of its own is allowed.
    expect(
      await writeEvidence(root, join(root, "docs/verification/x/after.png"), PNG, ".png"),
    ).toBe(written);
  });

  it("writes into a folder whose name starts with two dots", async () => {
    const { root } = fixture();
    const written = await writeEvidence(root, "..shots/after.png", PNG, ".png");
    expect(written).toBe(join(root, "..shots/after.png"));
    expect(await writeEvidence(root, join(root, "..shots/again.png"), PNG, ".png")).toBe(
      join(root, "..shots/again.png"),
    );
  });

  it("refuses paths that leave the checkout, links included, and the wrong kind of file", async () => {
    const { root, outside } = fixture();
    symlinkSync(outside, join(root, "escape"));
    writeFileSync(join(outside, "victim.png"), "keep");
    symlinkSync(join(outside, "victim.png"), join(root, "linked.png"));
    mkdirSync(join(root, "folder.png"));
    writeFileSync(join(outside, "hard.png"), "keep");
    linkSync(join(outside, "hard.png"), join(root, "hard.png"));
    for (const [path, extension] of [
      ["../outside/x.png", ".png"],
      [join(outside, "x.png"), ".png"],
      ["escape/x.png", ".png"],
      ["escape/deeper/new/x.png", ".png"],
      ["linked.png", ".png"],
      ["hard.png", ".png"],
      ["folder.png", ".png"],
      ["shot.jpg", ".png"],
      ["", ".png"],
      ["clip.png", ".gif"],
    ] as const)
      await expect(writeEvidence(root, path, PNG, extension), path).rejects.toBeInstanceOf(
        EvidencePathError,
      );
    expect(readFileSync(join(outside, "victim.png"), "utf8")).toBe("keep");
    expect(readFileSync(join(outside, "hard.png"), "utf8")).toBe("keep");
  });
});
