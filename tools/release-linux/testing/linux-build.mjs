// The release workflow's artifact as tests build it: an AppImage and a .deb with the right headers
// (and nothing else of either), and the LINUX-BUILD.json the workflow writes for them.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LINUX_BUILD_INFO, LINUX_WORKFLOW, linuxPackageNames } from "../linux-lib.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What the workflow's artifact holds for `version`: the two packages and LINUX-BUILD.json. */
export function writeLinuxBuild(
  dir,
  { version = "1.4.0", sourceCommit = "a".repeat(40), runId = 77, edit } = {},
) {
  mkdirSync(dir, { recursive: true });
  const { appImage, deb } = linuxPackageNames(version);
  const files = {
    [appImage]: Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02, 0, 0, 0, 0, 0]),
      Buffer.from(`Gram ${version} AppImage ${Math.random()}`),
    ]),
    [deb]: Buffer.from(`!<arch>\ndebian-binary   Gram ${version} ${Math.random()}`),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const info = {
    schema: 1,
    version,
    sourceCommit,
    workflow: LINUX_WORKFLOW,
    runId,
    files: Object.entries(files).map(([name, bytes]) => ({
      name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  writeFileSync(join(dir, LINUX_BUILD_INFO), JSON.stringify(edit ? edit(info) : info));
  return info;
}
