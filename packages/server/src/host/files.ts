import { Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { listFolder } from "../fs/files.ts";
import { listFileNames } from "../fs/names.ts";
import { searchFiles } from "../fs/search.ts";

/** Reading a machine's folders for the Files panel, already scoped to a checkout by the caller. */
export const filesOn = (proc: ProcShape) => {
  const on = Effect.provideService(Proc, proc);
  return {
    /** A folder's entries, dotfiles and git-ignored entries hidden unless asked for. */
    list: (path: string, options: Parameters<typeof listFolder>[1]) =>
      on(listFolder(path, options)),
    /** Lines matching `query` under `root`, through `git grep` in a repository. */
    search: (root: string, query: string, options: Parameters<typeof searchFiles>[2]) =>
      on(searchFiles(root, query, options)),
    /** Every file name under `root`, for the mention picker. */
    names: (root: string) => on(listFileNames(root)),
  };
};

export type HostFiles = ReturnType<typeof filesOn>;
