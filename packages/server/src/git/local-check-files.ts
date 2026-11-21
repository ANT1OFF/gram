// What retention reads of the files and folders local checks leave, links never followed.
import { lstatSync, readdirSync } from "node:fs";

/** A file's size and when it last changed, or undefined when it isn't a regular file. */
export const fileStat = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
};

/** A folder's stat, links not followed, or undefined when it isn't a folder. */
export const dirStat = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? stat : undefined;
  } catch {
    return undefined;
  }
};

/** The names in `dir`, or none when it can't be read. */
export const entries = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
