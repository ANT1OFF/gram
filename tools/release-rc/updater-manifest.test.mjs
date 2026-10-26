import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { writeUpdaterManifest } from "./updater-manifest.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const zipBytes = Buffer.from("PK\u0003\u0004 a signed Gram for this test");

function assetsWithZip(name) {
  const dir = mkdtempSync(join(tmpdir(), "gram-rc-manifest-"));
  writeFileSync(join(dir, name), zipBytes);
  return dir;
}

describe("writeUpdaterManifest", () => {
  it("writes rc-mac.yml naming the signed ZIP, its SHA-512 and size", async () => {
    const zipName = "gram_0.1.0-rc.17_darwin-arm64_signed.zip";
    const assets = assetsWithZip(zipName);
    const { name, text } = await writeUpdaterManifest({
      source,
      assets,
      version: "0.1.0-rc.17",
      zipName,
      releaseDate: "2026-10-16T12:00:00.000Z",
    });
    const sha512 = createHash("sha512").update(zipBytes).digest("base64");
    expect(name).toBe("rc-mac.yml");
    expect(readFileSync(join(assets, name), "utf8")).toBe(text);
    expect(text).toBe(
      [
        "version: 0.1.0-rc.17",
        "files:",
        `  - url: ${zipName}`,
        `    sha512: ${sha512}`,
        `    size: ${zipBytes.length}`,
        `path: ${zipName}`,
        `sha512: ${sha512}`,
        "releaseDate: '2026-10-16T12:00:00.000Z'",
        "",
      ].join("\n"),
    );
  });

  it("names a stable release's manifest latest-mac.yml", async () => {
    const zipName = "gram_0.1.0_darwin-arm64_signed.zip";
    const { name } = await writeUpdaterManifest({
      source,
      assets: assetsWithZip(zipName),
      version: "0.1.0",
      zipName,
      releaseDate: "2026-10-16T12:00:00.000Z",
    });
    expect(name).toBe("latest-mac.yml");
  });

  it("refuses to describe an unsigned ZIP", async () => {
    const zipName = "gram_0.1.0-rc.17_darwin-arm64_unsigned.zip";
    await expect(
      writeUpdaterManifest({
        source,
        assets: assetsWithZip(zipName),
        version: "0.1.0-rc.17",
        zipName,
        releaseDate: "2026-10-16T12:00:00.000Z",
      }),
    ).rejects.toThrow(/Invalid electron-updater manifest/);
  });
});
