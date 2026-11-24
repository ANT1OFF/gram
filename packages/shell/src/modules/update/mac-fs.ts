import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

const rawFs: typeof nodeFs = process.versions["electron"]
  ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Electron's `original-fs` is node:fs without its asar patches, the same API
    (createRequire(process.execPath)("original-fs") as typeof nodeFs)
  : nodeFs;
export const macFs = rawFs;
export const macFsPromises = rawFs.promises;
