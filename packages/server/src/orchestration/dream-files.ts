/**
 * A dream's folder on disk, and the only door to it.
 *
 * ```
 * <root>/<workspaceId>/
 *   dreams/<dreamId>/            the dream thread's cwd; an `acceptEdits` session may write all of it
 *     input/memory/…             a disposable copy of memory, written read-only
 *     input/sessions/NNN-….md    one rendered, scrubbed transcript each, written read-only
 *     input/INSTRUCTIONS.md      the user's steering, when there is any
 *     input/seed/NNN-….md        Claude Code's own memory for the repos, on an import that asked
 *     work/                      the agent's notes per session (pass 1)
 *     work/digests/<session>.md  its rolling digest of each thread, kept with the watermark on adopt
 *     output/…                   starts as a copy of memory; rewritten by the agent (pass 2)
 *     output/REPORT.md           what was merged, dropped and added; never memory
 *   dream-manifests/<dreamId>.json   input hashes and the baseline memory, OUTSIDE the dream folder
 *   dream-merges/<dreamId>/<runId>/  one empty cwd per merge run, removed after it; nothing is read back
 * ```
 *
 * Invariants. Every path comes from memory's resolver (`confinedTree`), so a symlink the agent
 * plants is refused, never followed. **Nothing the dream could write is ever trusted as the
 * baseline**: a prompt-injected transcript can rewrite `input/` before producing `output/`, so the
 * manifest, which holds the hashes `verifyInputs` checks and the memory text `reviewDream` diffs
 * against, lives beside the dream folders rather than inside one. The read-only bit on the inputs
 * is a speed bump, not the boundary. And what `collectOutput` returns has met the same path rules
 * and caps as a live memory write, scrubbed, before anyone is shown it.
 *
 * The baseline is the manifest's copy and not `versions/<n>/` because live writes change the
 * adopted version in place: by the time a dream ends, that folder is the current memory, not what
 * the dream started from.
 */
import { DREAM_SESSIONS_MAX, InvalidState, NotFound, type DreamFileDiff } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { redactText } from "../logging/redact.ts";
import {
  checkMemorySet,
  confinedTree,
  MEMORY_MAX_DEPTH,
  MEMORY_MAX_FILES,
  validateWorkspaceId,
  type MemoryError,
  type MemorySetFile,
} from "./memory.ts";

/** Cap on one rendered transcript as written; `renderTranscript` stays well under it. */
const DREAM_SESSION_MAX_BYTES = 1024 * 1024;
/** Cap on one seed file; Claude Code's memory files are a few KB each. */
export const DREAM_SEED_MAX_BYTES = 64 * 1024;
/** The most seed files one dream is given, so a folder of notes can't crowd out the sessions. */
export const DREAM_SEEDS_MAX = 40;
/** Cap on `output/REPORT.md` as read back. */
const DREAM_REPORT_MAX_BYTES = 256 * 1024;
/** Cap on one digest as read back; it is kept at a fraction of this. */
const DREAM_DIGEST_READ_MAX_BYTES = 64 * 1024;
/** The report's name in `output/`; the one file there that is not memory. */
export const DREAM_REPORT = "REPORT.md";

const INSTRUCTIONS = "INSTRUCTIONS.md";
const READ_ONLY = 0o444;
const DREAM_ID = /^[A-Za-z0-9-]{8,64}$/;

/** One rendered transcript on its way into `input/sessions/`. */
export interface DreamSessionFile {
  /** What the file is named after, e.g. a thread title; slugged, so anything goes. */
  readonly name: string;
  /** From `renderTranscript`; scrubbed again on the way to disk. */
  readonly text: string;
}

/** What `prepare` lays out. */
export interface PrepareDream {
  readonly workspaceId: string;
  readonly dreamId: string;
  /** The adopted version `memory` was read from; `""` for an import into no memory. */
  readonly memoryVersion: string;
  /** The current version's files: the baseline, and what `input/memory` and `output` start as. */
  readonly memory: ReadonlyArray<MemorySetFile>;
  readonly sessions: ReadonlyArray<DreamSessionFile>;
  readonly instructions?: string | undefined;
  /**
   * Seed material for `input/seed/`: read-only copies, hashed into the manifest like every
   * other input, and like them data the dream reads, never memory by themselves.
   */
  readonly seeds?: ReadonlyArray<DreamSessionFile> | undefined;
}

/** What the server remembers of a dream's start, where the dream can't write. */
const DreamManifest = Schema.Struct({
  dreamId: Schema.String,
  memoryVersion: Schema.String,
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** sha256 of every file under `input/`, by POSIX path relative to the dream folder. */
  inputs: Schema.Record(Schema.String, Schema.String),
  baseline: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
type DreamManifest = typeof DreamManifest.Type;

/** Whether a dream's inputs are still what the server wrote; `changed` lists what isn't, sorted. */
type DreamInputCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly changed: ReadonlyArray<string> };

/** A dream's candidate memory, already scrubbed and inside the caps. */
export interface DreamOutput {
  readonly files: ReadonlyArray<MemorySetFile>;
  /** `output/REPORT.md`, scrubbed. */
  readonly report?: string;
}

/**
 * The output can't become memory. `failure` is the `DreamFailure` it maps to: `over_caps` for
 * anything that breaks memory's path rules or caps (a symlink, a file that isn't Markdown, one too
 * big, too many), `no_output` for an output with no memory file in it.
 */
class DreamOutputRefused extends Data.TaggedError("DreamOutputRefused")<{
  readonly failure: "over_caps" | "no_output" | "missing_report";
  readonly message: string;
}> {}

export interface DreamFilesShape {
  /**
   * Lays out a new dream's folder and stores its manifest; returns the folder's absolute path, the
   * dream thread's cwd. Refuses a dream id that already has a folder.
   */
  prepare(input: PrepareDream): Effect.Effect<string, MemoryError>;
  /** Re-hashes `input/` against the manifest. Not ok means `input_tampered`. */
  verifyInputs(workspaceId: string, dreamId: string): Effect.Effect<DreamInputCheck, MemoryError>;
  /** The memory the dream started from, as the manifest kept it. */
  baseline(
    workspaceId: string,
    dreamId: string,
  ): Effect.Effect<
    { readonly memoryVersion: string; readonly files: ReadonlyArray<MemorySetFile> },
    MemoryError
  >;
  /** Reads `output/` back under memory's rules. */
  collectOutput(
    workspaceId: string,
    dreamId: string,
  ): Effect.Effect<DreamOutput, MemoryError | DreamOutputRefused>;
  /**
   * A fresh, empty folder for one merge run, outside the dream folder so the merge can't reach the
   * dream's inputs or output, and removed when the scope closes; its absolute path. One per run,
   * because a confined session may still write inside its cwd, and what one run left must not reach
   * the next. The merge answers in text, so nothing is ever read from it.
   */
  mergeFolder(
    workspaceId: string,
    dreamId: string,
  ): Effect.Effect<string, MemoryError, Scope.Scope>;
  /**
   * The digests pass 1 wrote, `work/digests/<file>` for each of `files` (their `input/sessions/`
   * names), scrubbed. One missing, too big or not a regular file is left out: the thread keeps the
   * digest it had.
   */
  readDigests(
    workspaceId: string,
    dreamId: string,
    files: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, string>, MemoryError>;
  /** Removes the dream's folder, its manifest and its merge folder. Safe to call again. */
  discard(workspaceId: string, dreamId: string): Effect.Effect<void, MemoryError>;
}

const refuse = (message: string) => new InvalidState({ message });

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const slug = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "session";

/** `input/sessions/` names: a zero-padded ordinal keeps them in the order given, whatever the slug. */
export const dreamSessionFileName = (index: number, name: string): string =>
  `${String(index + 1).padStart(3, "0")}-${slug(name)}.md`;

const byPath = (files: ReadonlyArray<MemorySetFile>): Map<string, string> =>
  new Map(files.map((file) => [file.path, file.content]));

/**
 * The review of a dream, pure: `output` against the memory the dream started from (`baseline`,
 * from the manifest), with `current` (memory now) deciding what a live write since then means.
 *
 * - The dream changed a file and the orchestrator didn't: `added`, `changed` or `removed`.
 * - Both did, differently: `conflict`, with all three sides.
 * - Only the orchestrator did: the live text is carried as `unchanged` (`before` and `after` both
 *   the current text), because an adoption replaces the whole version and would otherwise undo
 *   the write without saying so. A file the orchestrator deleted stays deleted and isn't listed.
 *
 * Nothing is ever compared with `input/`.
 */
export const reviewDream = (input: {
  readonly baseline: ReadonlyArray<MemorySetFile>;
  readonly current: ReadonlyArray<MemorySetFile>;
  readonly output: ReadonlyArray<MemorySetFile>;
}): ReadonlyArray<DreamFileDiff> => {
  const baseline = byPath(input.baseline);
  const current = byPath(input.current);
  const output = byPath(input.output);
  const paths = [...new Set([...baseline.keys(), ...current.keys(), ...output.keys()])].toSorted();
  return paths.flatMap((path): ReadonlyArray<DreamFileDiff> => {
    const before = baseline.get(path);
    const now = current.get(path);
    const after = output.get(path);
    const dreamt = after !== before;
    const live = now !== before;
    if (dreamt && live && after !== now) {
      return [
        {
          path,
          status: "conflict",
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          ...(now === undefined ? {} : { current: now }),
        },
      ];
    }
    // From here the dream either left the file alone or landed where the live write did, so what
    // memory holds now is the honest "before".
    const result = dreamt ? after : now;
    if (result === undefined) {
      return now === undefined ? [] : [{ path, status: "removed", before: now }];
    }
    if (now === undefined) return [{ path, status: "added", after: result }];
    return [{ path, status: result === now ? "unchanged" : "changed", before: now, after: result }];
  });
};

/** How an adoption settles one conflict: a side whole, or a merge's text of both. */
export type ConflictSide = "dream" | "current" | { readonly merged: string };

/**
 * The file set an adoption writes, from a review: every `after`, with each conflict settled by
 * `resolutions` (`dream` takes the output's side, `current` keeps the live write, `merged` writes
 * the text given). A conflict with no resolution is returned instead, since picking a side
 * silently is what the review exists to prevent.
 */
export const adoptionSet = (
  review: ReadonlyArray<DreamFileDiff>,
  resolutions: Readonly<Record<string, ConflictSide>> = {},
):
  | { readonly ok: true; readonly files: ReadonlyArray<MemorySetFile> }
  | { readonly ok: false; readonly unresolved: ReadonlyArray<string> } => {
  const unresolved = review
    .filter((file) => file.status === "conflict" && resolutions[file.path] === undefined)
    .map((file) => file.path);
  if (unresolved.length > 0) return { ok: false, unresolved };
  const files = review.flatMap((file): ReadonlyArray<MemorySetFile> => {
    const side = file.status === "conflict" ? resolutions[file.path] : undefined;
    const content =
      side === "current" ? file.current : typeof side === "object" ? side.merged : file.after;
    return content === undefined ? [] : [{ path: file.path, content }];
  });
  return { ok: true, files };
};

const dreamRel = (dreamId: string): string => `dreams/${dreamId}`;
const manifestRel = (dreamId: string): string => `dream-manifests/${dreamId}.json`;
const mergeRel = (dreamId: string): string => `dream-merges/${dreamId}`;

const noDream = (dreamId: string) =>
  new NotFound({ entity: "file", id: dreamId, message: `No dream ${dreamId} on disk` });

/** Runs `run` once the workspace id and the dream id are both ones the disk may be touched with. */
const guarded = <A, E, R = never>(
  workspaceId: string,
  dreamId: string,
  run: () => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InvalidState, R> =>
  Effect.gen(function* () {
    yield* validateWorkspaceId(workspaceId);
    // The id becomes a folder name and a file name; the contract's pattern, checked again here
    // because this is the layer that touches the disk.
    if (!DREAM_ID.test(dreamId)) return yield* refuse("Not a dream id a folder can be named after");
    return yield* run();
  });

/** The refusal of a dream's output for breaking memory's caps. */
const overCaps = (message: string) => new DreamOutputRefused({ failure: "over_caps", message });

/**
 * `effect` with the resolver's refusals turned into the dream's: when reading `output/`, they are
 * about what the agent left there, not the caller's mistake.
 */
const asRefusal = <A>(effect: Effect.Effect<A, MemoryError>) =>
  effect.pipe(Effect.catchTag("InvalidState", (error) => Effect.fail(overCaps(error.message))));

const make = (root: string): DreamFilesShape => {
  const tree = confinedTree(root, { anchored: true });

  const readManifest = (workspaceId: string, dreamId: string) =>
    Effect.gen(function* () {
      const rel = manifestRel(dreamId);
      const file = yield* tree.resolveInTree(workspaceId, rel, "dream-manifests");
      if (file.kind !== "file") return yield* noDream(dreamId);
      const text = yield* tree.readText(
        workspaceId,
        rel,
        "dream-manifests",
        "the dream's manifest",
        // Forty files of 32 KB, JSON-escaped, plus a hundred hashes.
        4 * 1024 * 1024,
      );
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(DreamManifest)(JSON.parse(text)),
        catch: () => refuse("The dream's manifest can't be read, so the dream can't be trusted"),
      });
    });

  /**
   * Every entry below `rel`, files as POSIX paths relative to it. `other` entries (symlinks,
   * sockets) and folders past `maxDepth` are reported, not entered, for the caller to refuse.
   */
  const walk = (workspaceId: string, rel: string, within: string, maxDepth: number) =>
    Effect.gen(function* () {
      const files: Array<string> = [];
      const strange: Array<string> = [];
      const visit = (relDir: string, depth: number): Effect.Effect<void, MemoryError> =>
        Effect.gen(function* () {
          const entries = yield* tree.listDir(
            workspaceId,
            relDir === "" ? rel : `${rel}/${relDir}`,
            within,
          );
          for (const entry of entries ?? []) {
            const path = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
            if (entry.kind === "file") files.push(path);
            else if (entry.kind === "other" || depth >= maxDepth) strange.push(path);
            else yield* visit(path, depth + 1);
          }
        });
      yield* visit("", 1);
      return { files: files.toSorted(), strange: strange.toSorted() };
    });

  return {
    prepare: (input) =>
      guarded(input.workspaceId, input.dreamId, () =>
        Effect.gen(function* () {
          const { workspaceId, dreamId } = input;
          if (input.sessions.length > DREAM_SESSIONS_MAX) {
            return yield* refuse(
              `${input.sessions.length} transcripts; a dream reads at most ${DREAM_SESSIONS_MAX}. Chain dreams for more.`,
            );
          }
          // An import starts from no memory at all, which no memory set is allowed to be.
          const checked =
            input.memory.length === 0
              ? { ok: true as const, files: [] }
              : checkMemorySet(input.memory);
          if (!checked.ok) return yield* refuse(checked.problem);
          const sessions = input.sessions.map((session, index) => ({
            rel: `input/sessions/${dreamSessionFileName(index, session.name)}`,
            text: redactText(session.text),
          }));
          for (const session of sessions) {
            if (Buffer.byteLength(session.text, "utf8") > DREAM_SESSION_MAX_BYTES) {
              return yield* refuse(`${session.rel} is past the 1 MB a rendered transcript may be`);
            }
          }

          const given = input.seeds ?? [];
          if (given.length > DREAM_SEEDS_MAX) {
            return yield* refuse(
              `${given.length} seed files; a dream is given at most ${DREAM_SEEDS_MAX}`,
            );
          }
          const seeds = given.map((seed, index) => ({
            rel: `input/seed/${dreamSessionFileName(index, seed.name)}`,
            text: redactText(seed.text),
          }));
          for (const seed of seeds) {
            if (Buffer.byteLength(seed.text, "utf8") > DREAM_SEED_MAX_BYTES) {
              return yield* refuse(`${seed.rel} is past the 64 KB a seed file may be`);
            }
          }

          const within = dreamRel(dreamId);
          const existing = yield* tree.resolveInTree(workspaceId, within, "dreams");
          if (existing.kind !== "missing")
            return yield* refuse(`Dream ${dreamId} already has a folder`);

          const inputs: Array<{ rel: string; text: string }> = [
            ...checked.files.map((file) => ({
              rel: `input/memory/${file.path}`,
              text: file.content,
            })),
            ...sessions,
            ...seeds,
            ...(input.instructions === undefined || input.instructions.trim() === ""
              ? []
              : [{ rel: `input/${INSTRUCTIONS}`, text: redactText(input.instructions) }]),
          ];
          const now = yield* Clock.currentTimeMillis;
          const manifest: DreamManifest = {
            dreamId,
            memoryVersion: input.memoryVersion,
            createdAt: now,
            inputs: Object.fromEntries(inputs.map((file) => [file.rel, sha256(file.text)])),
            baseline: checked.files,
          };
          // The manifest first: a folder without one can't be verified, so it can't be adopted; a
          // manifest without a folder is only litter `discard` clears.
          yield* tree.writeAtomic(
            workspaceId,
            manifestRel(dreamId),
            "dream-manifests",
            JSON.stringify(manifest),
          );
          const layOut = Effect.gen(function* () {
            for (const dir of [
              "input/memory",
              "input/sessions",
              ...(seeds.length === 0 ? [] : ["input/seed"]),
              "work",
              "work/digests",
              "output",
            ]) {
              yield* tree.ensureDir(workspaceId, `${within}/${dir}`, "dreams");
            }
            for (const file of inputs) {
              yield* tree.writeAtomic(
                workspaceId,
                `${within}/${file.rel}`,
                within,
                file.text,
                READ_ONLY,
              );
            }
            for (const file of checked.files) {
              yield* tree.writeAtomic(
                workspaceId,
                `${within}/output/${file.path}`,
                within,
                file.content,
              );
            }
          });
          yield* layOut.pipe(
            Effect.onError(() =>
              Effect.ignore(
                Effect.andThen(
                  tree.removeTree(workspaceId, within, "dreams"),
                  tree.removeFile(workspaceId, manifestRel(dreamId), "dream-manifests"),
                ),
              ),
            ),
          );
          const dir = yield* tree.resolveInTree(workspaceId, within, "dreams");
          return dir.abs;
        }),
      ),

    verifyInputs: (workspaceId, dreamId) =>
      guarded(workspaceId, dreamId, () =>
        Effect.gen(function* () {
          const manifest = yield* readManifest(workspaceId, dreamId);
          const within = dreamRel(dreamId);
          const changed = new Set<string>();
          // A swapped-in symlink anywhere on the way is tampering too, not an error to report.
          const found = yield* walk(workspaceId, `${within}/input`, within, 8).pipe(
            Effect.catchTag("InvalidState", () => Effect.succeed(undefined)),
          );
          if (found === undefined) return { ok: false, changed: ["input"] };
          for (const path of found.strange) changed.add(`input/${path}`);
          const present = new Set(found.files.map((path) => `input/${path}`));
          for (const rel of Object.keys(manifest.inputs)) if (!present.has(rel)) changed.add(rel);
          for (const rel of present) {
            const expected = manifest.inputs[rel];
            if (expected === undefined) {
              changed.add(rel);
              continue;
            }
            const text = yield* tree
              .readText(workspaceId, `${within}/${rel}`, within, rel, 2 * DREAM_SESSION_MAX_BYTES)
              .pipe(Effect.catchTag("InvalidState", () => Effect.succeed(undefined)));
            if (text === undefined || sha256(text) !== expected) changed.add(rel);
          }
          return changed.size === 0
            ? { ok: true }
            : { ok: false, changed: [...changed].toSorted() };
        }),
      ),

    baseline: (workspaceId, dreamId) =>
      guarded(workspaceId, dreamId, () =>
        Effect.map(readManifest(workspaceId, dreamId), (manifest) => ({
          memoryVersion: manifest.memoryVersion,
          files: manifest.baseline,
        })),
      ),

    collectOutput: (workspaceId, dreamId) =>
      guarded(workspaceId, dreamId, () =>
        Effect.gen(function* () {
          const within = dreamRel(dreamId);
          if ((yield* tree.resolveInTree(workspaceId, within, "dreams")).kind !== "dir") {
            return yield* noDream(dreamId);
          }
          const found = yield* asRefusal(
            walk(workspaceId, `${within}/output`, within, MEMORY_MAX_DEPTH),
          );
          if (found.strange.length > 0) {
            return yield* overCaps(
              `output/${found.strange[0]!} is a symlink, a special file or a folder nested too deep; memory holds regular files at most ${MEMORY_MAX_DEPTH} levels deep`,
            );
          }
          const paths = found.files.filter((path) => path !== DREAM_REPORT);
          if (paths.length > MEMORY_MAX_FILES) {
            return yield* overCaps(
              `${paths.length} files in output/; a memory version holds at most ${MEMORY_MAX_FILES}`,
            );
          }
          if (paths.length === 0) {
            return yield* new DreamOutputRefused({
              failure: "no_output",
              message: "The dream left no memory file in output/",
            });
          }
          const files: Array<MemorySetFile> = [];
          for (const path of paths) {
            const content = yield* asRefusal(
              tree.readText(workspaceId, `${within}/output/${path}`, within, `output/${path}`),
            );
            files.push({ path, content });
          }
          const checked = checkMemorySet(files);
          if (!checked.ok) return yield* overCaps(checked.problem);
          const report = found.files.includes(DREAM_REPORT)
            ? redactText(
                yield* asRefusal(
                  tree.readText(
                    workspaceId,
                    `${within}/output/${DREAM_REPORT}`,
                    within,
                    `output/${DREAM_REPORT}`,
                    DREAM_REPORT_MAX_BYTES,
                  ),
                ),
              )
            : undefined;
          if (report === undefined || report.trim() === "")
            return yield* new DreamOutputRefused({
              failure: "missing_report",
              message:
                "The dream ended without a nonempty output/REPORT.md; seeded memory alone is not a completed consolidation",
            });
          return { files: checked.files, report };
        }),
      ),

    readDigests: (workspaceId, dreamId, names) =>
      guarded(workspaceId, dreamId, () =>
        Effect.gen(function* () {
          const within = dreamRel(dreamId);
          const found = new Map<string, string>();
          for (const name of names) {
            const text = yield* tree
              .readText(
                workspaceId,
                `${within}/work/digests/${name}`,
                within,
                `work/digests/${name}`,
                DREAM_DIGEST_READ_MAX_BYTES,
              )
              .pipe(Effect.orElseSucceed(() => undefined));
            if (text !== undefined) found.set(name, redactText(text));
          }
          return found;
        }),
      ),

    mergeFolder: (workspaceId, dreamId) =>
      guarded(workspaceId, dreamId, () => {
        const rel = `${mergeRel(dreamId)}/${randomUUID()}`;
        return Effect.acquireRelease(tree.ensureDir(workspaceId, rel, "dream-merges"), () =>
          Effect.ignore(tree.removeTree(workspaceId, rel, "dream-merges")),
        );
      }),

    discard: (workspaceId, dreamId) =>
      guarded(workspaceId, dreamId, () =>
        Effect.andThen(
          tree.removeTree(workspaceId, dreamRel(dreamId), "dreams"),
          Effect.andThen(
            tree.removeFile(workspaceId, manifestRel(dreamId), "dream-manifests"),
            tree.removeTree(workspaceId, mergeRel(dreamId), "dream-merges"),
          ),
        ),
      ),
  };
};

/** Dream folders, beside each workspace's memory under the data dir. */
export class DreamFiles extends Context.Service<DreamFiles, DreamFilesShape>()(
  "@gram/server/DreamFiles",
) {
  /** Dream folders under `root`, the folder that holds one folder per workspace. */
  static readonly layerAt = (root: string): Layer.Layer<DreamFiles> =>
    Layer.sync(DreamFiles, () => make(root));

  /** Dream folders under `<dataDir>/orchestration`, memory's root. */
  static readonly layer: Layer.Layer<DreamFiles, never, ServerConfig> = Layer.effect(
    DreamFiles,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return make(join(config.dataDir, "orchestration"));
    }),
  );
}
