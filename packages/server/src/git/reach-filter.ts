// What a thread's agent is shown of a list the server read with its own GitHub access (the review
// requests and open PRs polls): behind an embedding deployment's GitHub route, only the entries of
// repositories the thread works in (`repo-reach.ts`). Elsewhere the list is the person's own.

import type { Thread } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { githubRelayed } from "../embedding/github-relay.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { repoOutOfReach } from "./repo-reach.ts";

/** `items` without those of a repository `thread` doesn't work in, behind a GitHub route. */
export const inReachOnly = <A>(
  store: ThreadStoreShape,
  thread: Thread | undefined,
  items: ReadonlyArray<A>,
  repoOf: (item: A) => string,
) =>
  Effect.gen(function* () {
    if (!githubRelayed()) return items;
    if (thread === undefined) return [];
    const repos = [...new Set(items.map((item) => repoOf(item).toLowerCase()))];
    const reachable = new Set<string>();
    for (const repo of repos) {
      if ((yield* repoOutOfReach(store, thread, repo)) === undefined) reachable.add(repo);
    }
    return items.filter((item) => reachable.has(repoOf(item).toLowerCase()));
  });
