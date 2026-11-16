// How far a worktree's content is the user's own. A fork's pull request head is someone else's
// tree: Gram copies nothing of the main checkout's into it (`.worktreeinclude` files, permission
// rules) and offers nothing of its settings back. The level is kept with the worktree, in its own
// git dir (`.git/worktrees/<id>/`), which the checked-out tree can't write and which goes with the
// worktree when git removes it, so every later reader (reopening, the removal checklist, a restart)
// sees it whichever thread made it.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { CheckoutTrust } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { type Buckets, emptyBuckets, extractRules } from "./claude-settings.ts";
import { git } from "./exec.ts";
import { samePathKey } from "./paths.ts";
import type { Proc } from "./proc.ts";

export type WorktreeTrust = CheckoutTrust;

const MARKER = "gram-trust";
const UNTRUSTED = "untrusted";

/** The linked worktree's own git dir; `undefined` for a main checkout or when git can't say. */
const linkedGitDir = (worktreeDir: string): Effect.Effect<string | undefined, never, Proc> =>
  git(worktreeDir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).pipe(
    Effect.map((out) => {
      if (out.status !== 0) return undefined;
      const [gitDir = "", common = ""] = out.stdout.split("\n").map((line) => line.trim());
      if (gitDir === "" || common === "" || samePathKey(gitDir) === samePathKey(common)) {
        return undefined;
      }
      return gitDir;
    }),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Records `worktreeDir` as untrusted. Fails when it can't, so a tree that would otherwise read as
 * the user's own is never handed out. A main checkout is never marked: its trust lives only on the
 * thread's checkout.
 */
export const markWorktreeUntrusted = (worktreeDir: string): Effect.Effect<void, Error, Proc> =>
  Effect.gen(function* () {
    const gitDir = yield* linkedGitDir(worktreeDir);
    if (gitDir === undefined) {
      return yield* Effect.fail(new Error(`couldn't find ${worktreeDir}'s git folder`));
    }
    yield* Effect.try({
      try: () => fs.writeFileSync(nodePath.join(gitDir, MARKER), `${UNTRUSTED}\n`),
      catch: (error) =>
        new Error(
          `couldn't record ${worktreeDir} as untrusted: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
  });

/** The trust recorded for a linked worktree: `untrusted` once marked, else `trusted`. */
export const worktreeTrust = (worktreeDir: string): Effect.Effect<WorktreeTrust, never, Proc> =>
  linkedGitDir(worktreeDir).pipe(
    Effect.map((gitDir) => {
      if (gitDir === undefined) return "trusted" as const;
      try {
        return fs.readFileSync(nodePath.join(gitDir, MARKER), "utf8").trim() === UNTRUSTED
          ? ("untrusted" as const)
          : ("trusted" as const);
      } catch {
        return "trusted" as const;
      }
    }),
  );

const SETTINGS_LOCAL = ".claude/settings.local.json";

/** The permission rules in one committed or staged copy of the settings file; none when absent. */
const rulesAt = (worktreeDir: string, spec: string): Effect.Effect<Buckets, never, Proc> =>
  git(worktreeDir, ["show", spec]).pipe(
    Effect.map((out) => {
      if (out.status !== 0 || out.truncated) return emptyBuckets;
      try {
        return extractRules(JSON.parse(out.stdout));
      } catch {
        return emptyBuckets;
      }
    }),
    Effect.orElseSucceed(() => emptyBuckets),
  );

/**
 * The rules the checked-out branch itself tracks in `.claude/settings.local.json`, at `HEAD` and
 * in the index: the branch's author wrote them, so they were never approved through Gram.
 */
export const trackedPermissionRules = (worktreeDir: string): Effect.Effect<Buckets, never, Proc> =>
  Effect.all([
    rulesAt(worktreeDir, `HEAD:${SETTINGS_LOCAL}`),
    rulesAt(worktreeDir, `:${SETTINGS_LOCAL}`),
  ]).pipe(
    Effect.map(([head, index]) => ({
      allow: [...head.allow, ...index.allow],
      deny: [...head.deny, ...index.deny],
      ask: [...head.ask, ...index.ask],
    })),
  );
