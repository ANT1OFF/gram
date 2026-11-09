// Only download caches belong in Actions caches. Seed checksums from the pinned npm package,
// not from an unverified network response or a previous workflow's checksum file.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export function seedChecksums(cacheRoot, version, checksums) {
  const entries = Object.entries(checksums);
  if (
    !entries.length ||
    entries.some(([name, hash]) => !/^[\w.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error("Invalid Electron checksums");
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(
    join(cacheRoot, `SHASUMS256.txt-${version}`),
    entries.map(([name, hash]) => `${hash} *${name}\n`).join(""),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = json(join(root, "package.json")).workspaces.catalog;
  if (process.argv[2] === "--key") {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `versions=builder-${catalog["electron-builder"]}-electron-${catalog.electron}\n`,
    );
  } else if (process.argv[2] === "--seed-checksums") {
    const electron = join(root, "node_modules/electron");
    if (json(join(electron, "package.json")).version !== catalog.electron)
      throw new Error("Installed Electron does not match the catalog");
    const cacheRoot =
      process.platform === "darwin"
        ? join(homedir(), "Library/Caches/electron")
        : join(homedir(), ".cache/electron");
    seedChecksums(cacheRoot, catalog.electron, json(join(electron, "checksums.json")));
  } else {
    throw new Error("Expected --key or --seed-checksums");
  }
}
