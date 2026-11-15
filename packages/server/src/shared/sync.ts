// Keeping two copies of a shared folder in step: the control plane's own and one machine's mirror.
//
// A round lists both sides and compares each file with what the last round left them agreeing on
// (the base). A file changed on one side only goes to the other; a file deleted on one side only is
// deleted on the other. Changed on both: the later write wins, and an edit always beats a delete.
// Every write and delete names the hash it expects to replace, so a file changed again since the
// listing is left for the next round rather than overwritten.

import {
  SHARED_ABSENT,
  SHARED_PART_BYTES,
  type SharedEntry,
  type SharedListing,
  type SharedPart,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { SharedWrite } from "./tree.ts";

/** One side of a sync, the calls `SharedTree` makes, failing with anything. */
export interface SharedSide {
  readonly list: Effect.Effect<SharedListing, unknown>;
  readonly read: (
    path: string,
    offset: number,
    length: number,
  ) => Effect.Effect<SharedPart, unknown>;
  readonly write: (write: SharedWrite) => Effect.Effect<{ readonly placed: boolean }, unknown>;
  readonly remove: (
    path: string,
    ifMatch: string,
  ) => Effect.Effect<{ readonly removed: boolean }, unknown>;
}

/** What the two sides last agreed on: each file's hash. */
export type SharedBase = Readonly<Record<string, string>>;

export type SharedStep =
  | {
      readonly kind: "copy";
      readonly from: "server" | "host";
      readonly entry: SharedEntry;
      readonly ifMatch: string;
    }
  | {
      readonly kind: "delete";
      readonly on: "server" | "host";
      readonly path: string;
      readonly ifMatch: string;
    };

export interface SharedPlan {
  readonly steps: ReadonlyArray<SharedStep>;
  /** The base for paths the round leaves as they are: the same on both sides, or held. */
  readonly settled: Record<string, string>;
}

const byPath = (listing: SharedListing) => new Map(listing.entries.map((e) => [e.path, e]));

/** What a round should do, from both listings and the base. */
export const planRound = (
  server: SharedListing,
  host: SharedListing,
  base: SharedBase,
): SharedPlan => {
  const onServer = byPath(server);
  const onHost = byPath(host);
  const held = new Set([...server.held, ...host.held]);
  const paths = new Set([...onServer.keys(), ...onHost.keys(), ...Object.keys(base)]);
  const steps: SharedStep[] = [];
  const settled: Record<string, string> = {};
  for (const path of [...paths].toSorted()) {
    const was = base[path];
    if (held.has(path)) {
      if (was !== undefined) settled[path] = was;
      continue;
    }
    const s = onServer.get(path);
    const h = onHost.get(path);
    // A file a cut-off listing doesn't name may be there: it is neither deleted nor copied over.
    if ((s === undefined && !server.complete) || (h === undefined && !host.complete)) {
      if (was !== undefined) settled[path] = was;
      continue;
    }
    if (s?.sha256 === h?.sha256) {
      if (s !== undefined) settled[path] = s.sha256;
      continue;
    }
    const serverChanged = s?.sha256 !== was;
    const hostChanged = h?.sha256 !== was;
    const toHost = (entry: SharedEntry) =>
      steps.push({ kind: "copy", from: "server", entry, ifMatch: h?.sha256 ?? SHARED_ABSENT });
    const toServer = (entry: SharedEntry) =>
      steps.push({ kind: "copy", from: "host", entry, ifMatch: s?.sha256 ?? SHARED_ABSENT });
    if (serverChanged && !hostChanged) {
      if (s !== undefined) toHost(s);
      else if (h !== undefined) steps.push({ kind: "delete", on: "host", path, ifMatch: h.sha256 });
    } else if (hostChanged && !serverChanged) {
      if (h !== undefined) toServer(h);
      else if (s !== undefined)
        steps.push({ kind: "delete", on: "server", path, ifMatch: s.sha256 });
    } else if (s !== undefined && h !== undefined) {
      // Both changed: the later write wins, the control plane's on a tie.
      if (h.mtimeMs > s.mtimeMs) toServer(h);
      else toHost(s);
    } else if (s !== undefined) {
      toHost(s);
    } else if (h !== undefined) {
      toServer(h);
    }
  }
  return { steps, settled };
};

/** Copies one file from `source` to `target`; false when either side changed it meanwhile. */
const copy = (
  source: SharedSide,
  target: SharedSide,
  entry: SharedEntry,
  ifMatch: string,
): Effect.Effect<boolean, unknown> =>
  Effect.gen(function* () {
    let offset = 0;
    for (;;) {
      const part = yield* source.read(entry.path, offset, SHARED_PART_BYTES);
      if (part.sha256 !== entry.sha256 || part.size !== entry.size) return false;
      const bytes = Buffer.byteLength(part.data, "base64");
      const last = offset + bytes >= entry.size;
      const { placed } = yield* target.write({
        path: entry.path,
        offset,
        data: part.data,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: entry.sha256,
        ifMatch,
      });
      if (last) return placed;
      if (bytes === 0) return false;
      offset += bytes;
    }
  });

export interface SharedRound {
  readonly base: Record<string, string>;
  readonly copied: number;
  readonly deleted: number;
  /** Steps refused because a side changed meanwhile, or that failed; the next round tries again. */
  readonly deferred: number;
}

/** One round between the control plane's copy and a machine's mirror. */
export const syncRound = (
  server: SharedSide,
  host: SharedSide,
  base: SharedBase,
): Effect.Effect<SharedRound, unknown> =>
  Effect.gen(function* () {
    const [onServer, onHost] = yield* Effect.all([server.list, host.list], {
      concurrency: 2,
    });
    const plan = planRound(onServer, onHost, base);
    const next: Record<string, string> = { ...plan.settled };
    let copied = 0;
    let deleted = 0;
    let deferred = 0;
    const keepBase = (path: string) => {
      const was = base[path];
      if (was !== undefined) next[path] = was;
    };
    for (const step of plan.steps) {
      if (step.kind === "copy") {
        const [source, target] = step.from === "server" ? [server, host] : [host, server];
        const placed = yield* copy(source, target, step.entry, step.ifMatch).pipe(
          Effect.catch(() => Effect.succeed(false)),
        );
        if (placed) {
          next[step.entry.path] = step.entry.sha256;
          copied += 1;
        } else {
          keepBase(step.entry.path);
          deferred += 1;
        }
      } else {
        const side = step.on === "server" ? server : host;
        const { removed } = yield* side
          .remove(step.path, step.ifMatch)
          .pipe(Effect.catch(() => Effect.succeed({ removed: false })));
        if (removed) deleted += 1;
        else {
          keepBase(step.path);
          deferred += 1;
        }
      }
    }
    return { base: next, copied, deleted, deferred };
  });
