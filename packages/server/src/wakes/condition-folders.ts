import type { Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { folderExists } from "../fs/folders.ts";

/** A folder of the thread's to run gh in: its checkout, or its repo's main one. */
export const folderOf = (thread: Thread) =>
  Effect.gen(function* () {
    const cwd = thread.checkout.path;
    return (yield* folderExists(cwd)) || thread.checkout.repoRoot === undefined
      ? cwd
      : thread.checkout.repoRoot;
  });
