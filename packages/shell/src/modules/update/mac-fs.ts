// Integrity checks and bundle copying must see the physical app.asar file. Electron's patched
// fs reports ASAR files as virtual directories, which changes modes and can unpack them during cp.
// Use the documented original-fs API without changing process.noAsar for other app operations.
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";

const rawFs: typeof nodeFs = process.versions["electron"]
  ? (createRequire(process.execPath)("original-fs") as typeof nodeFs)
  : nodeFs;
export const macFs = rawFs;
export const macFsPromises = rawFs.promises;
