// The `gh` reads made for one thread carry its handle (`ghThreadEnv`), so behind a GitHub relay
// the route answers them for that thread and no other. A module of its own, apart from the relay,
// so a test can stand in for the relay's handle.

import { asGhCaller } from "@gram/git";
import type { ThreadId } from "@gram/contracts";
import { ghThreadEnv } from "./github-relay.ts";

/** The caller environment of `threadId`'s reads: its handle behind a relay, else none. */
export const threadCaller = (threadId: ThreadId | string): Readonly<Record<string, string>> =>
  ghThreadEnv(threadId);

/** Runs `effect` with every `gh` read in it made for `threadId`. */
export const forThread = (threadId: ThreadId | string) => asGhCaller(threadCaller(threadId));
