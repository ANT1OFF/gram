// electron-updater's manifest for a signed RC (`rc-mac.yml`, or `latest-mac.yml` for a stable
// release): rendered with the app's own renderer and read back through electron-updater's own
// parser and the app's own validation, so the release can't publish one the app would refuse.
import { createHash } from "node:crypto";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { updaterManifestName } from "./rc-lib.mjs";

const sha512Base64 = (path) =>
  new Promise((done, reject) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("base64")))
      .on("error", reject);
  });

/**
 * Writes the manifest for `zipName` in `assets` and returns its name and text. `source` is the
 * checkout being released: its updater module renders and validates, and its installed
 * electron-updater parses.
 */
export async function writeUpdaterManifest({ source, assets, version, zipName, releaseDate }) {
  const { nativeManifestName, renderNativeManifest, validateNativeManifest } = await import(
    pathToFileURL(join(source, "packages/shell/src/modules/update/native-release.ts")).href
  );
  const name = updaterManifestName(version);
  if (nativeManifestName(version) !== name)
    throw new Error(`the release tool and the app disagree on the manifest name for ${version}`);
  const zip = join(assets, zipName);
  const size = statSync(zip).size;
  const text = renderNativeManifest({
    version,
    zip: zipName,
    sha512: await sha512Base64(zip),
    size,
    releaseDate,
  });
  const require = createRequire(join(source, "apps/desktop/package.json"));
  const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");
  const parsed = parseUpdateInfo(text, name, new URL("https://github.com/"));
  validateNativeManifest(parsed, { version, size });
  if (parsed.sha512 !== (await sha512Base64(zip)))
    throw new Error(`${name} does not carry the ZIP's SHA-512`);
  writeFileSync(join(assets, name), text);
  return { name, text };
}
