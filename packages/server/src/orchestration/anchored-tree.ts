import * as Effect from "effect/Effect";
import { InvalidState, type NotFound } from "@gram/contracts";
import { join } from "node:path";
import { anchoredRequest, type AnchoredOptions } from "./anchored-files.ts";
import type { ConfinedTree, Resolved, TreeEntry } from "./memory.ts";

const noMissing = <A>(effect: Effect.Effect<A, InvalidState | NotFound>) =>
  effect.pipe(
    Effect.catchTag("NotFound", (e) =>
      Effect.fail(new InvalidState({ message: e.message ?? "Confined path missing" })),
    ),
  );

/** The strong implementation of the same tree contract, for Dream and its adoption seam. */
export const anchoredTree = (root: string, options: AnchoredOptions = {}): ConfinedTree => ({
  resolveInTree: (workspaceId, rel, within) =>
    noMissing(
      anchoredRequest<Omit<Resolved, "abs">>(
        root,
        { op: "resolve", workspaceId, rel, within },
        options,
      ),
    ).pipe(Effect.map((resolved) => ({ ...resolved, abs: join(root, workspaceId, rel) }))),
  ensureDir: (workspaceId, rel, within) =>
    noMissing(anchoredRequest<void>(root, { op: "mkdir", workspaceId, rel, within }, options)).pipe(
      Effect.as(join(root, workspaceId, rel)),
    ),
  writeAtomic: (workspaceId, rel, within, content, mode = 0o600) =>
    noMissing(
      anchoredRequest<void>(
        root,
        { op: "write", workspaceId, rel, within, content, mode },
        options,
      ),
    ),
  readText: (workspaceId, rel, within, _shown, maxBytes = 256 * 1024) =>
    anchoredRequest<string>(root, { op: "read", workspaceId, rel, within, maxBytes }, options),
  fingerprint: (workspaceId, rel, within, _shown, maxBytes = 256 * 1024) =>
    anchoredRequest<{ readonly sha256: string; readonly bytes: number }>(
      root,
      { op: "fingerprint", workspaceId, rel, within, maxBytes },
      options,
    ),
  listDir: (workspaceId, rel, within) =>
    noMissing(
      anchoredRequest<ReadonlyArray<TreeEntry> | null>(
        root,
        { op: "list", workspaceId, rel, within },
        options,
      ),
    ).pipe(Effect.map((entries) => entries ?? undefined)),
  removeFile: (workspaceId, rel, within) =>
    noMissing(anchoredRequest<void>(root, { op: "unlink", workspaceId, rel, within }, options)),
  removeTree: (workspaceId, rel, within) =>
    noMissing(anchoredRequest<void>(root, { op: "rmtree", workspaceId, rel, within }, options)),
});
