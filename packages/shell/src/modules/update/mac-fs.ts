import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

const rawFs: typeof nodeFs = process.versions["electron"]
  ? (createRequire(process.execPath)("original-fs") as typeof nodeFs)
  : nodeFs;
export const macFs = rawFs;
export const macFsPromises = rawFs.promises;
