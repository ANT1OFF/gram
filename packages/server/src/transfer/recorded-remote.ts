import type { Project } from "@gram/contracts";
import { cachedOriginUrl } from "@gram/git";
import * as Effect from "effect/Effect";
import { cloneIdentityOf, originIdentityAt } from "../host/repos.ts";
import { recordedCloneIdentity } from "../git/recorded-clone.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { redactText } from "../logging/redact.ts";

/**
 * A repository's `origin` as it may be said to another server: a network address, with no
 * password, no token standing in for a user, no query and no fragment; `undefined` for anything
 * else, such as a path on this machine.
 */
export const shareableRemote = (url: string): string | undefined => {
  const text = url.trim();
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(text)) return redactText(text);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
  if (parsed.protocol !== "ssh:" || parsed.username !== "git") parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return redactText(parsed.toString());
};

/** `root`'s origin URL, while its identity is still the one its project recorded. */
export const recordedOriginUrl = (store: Pick<ThreadStoreShape, "listProjects">, root: string) =>
  Effect.gen(function* () {
    const url = yield* cachedOriginUrl(root);
    if (url === undefined) return undefined;
    yield* recordedCloneIdentity(yield* store.listProjects, root, cloneIdentityOf(url));
    return url;
  });

/** The clone identity a checkout made in `top` records: its project's recorded origin. */
export const recordedOriginAt = (store: Pick<ThreadStoreShape, "listProjects">, top: string) =>
  originIdentityAt(top).pipe(
    Effect.flatMap((live) =>
      Effect.flatMap(store.listProjects, (projects) => recordedCloneIdentity(projects, top, live)),
    ),
  );

/** The clone identity of `url` for a checkout of `project`, refused unless it is its recorded one. */
export const recordedCloneOf = (project: Project, url: string) =>
  recordedCloneIdentity([project], project.root, cloneIdentityOf(url));
