import type { Thread } from "@gram/contracts";
import type * as Effect from "effect/Effect";
import { ghFolderOf } from "../fs/folders.ts";

/**
 * A folder of the thread's to run gh in: its checkout, or its repo's main one, and this machine's
 * temp folder for a thread on another machine (`ghFolderOf`).
 */
export const folderOf = (thread: Thread): Effect.Effect<string> => ghFolderOf(thread.checkout);
