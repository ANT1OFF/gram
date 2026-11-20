import type { ThreadSummary, VerifyState } from "@gram/contracts";

/**
 * A worker's verify recipe as the mock serves it: three drivers passed on the worker's head, one
 * passed only on an older commit and so not run on this one, and one that failed. A thread
 * outside git, or that no orchestrator started, has no recipe.
 */
export const mockVerifyState = (summary: ThreadSummary): VerifyState => {
  const head = summary.git?.head;
  if (summary.thread.spawnedBy === undefined || summary.git?.repo !== true || head === undefined)
    return { recipe: "none", drivers: [] };
  const at = Date.parse("2026-09-16T18:00:00Z");
  return {
    recipe: "ok",
    head,
    drivers: [
      {
        name: "affected",
        run: "bun install --frozen-lockfile && bun run check:affected",
        kind: "unit",
        required: true,
        coversChange: true,
        status: "passed",
        startedAt: at,
        finishedAt: at + 134_000,
      },
      {
        name: "types",
        run: "bun install --frozen-lockfile && bun run typecheck",
        kind: "types",
        required: true,
        coversChange: true,
        status: "passed",
        startedAt: at,
        finishedAt: at + 48_000,
      },
      {
        name: "shots",
        run: "bun run --filter @gram/web pr:shots --set tour",
        kind: "shots",
        coversChange: true,
        status: "failed",
        reason: "exited with 1",
        startedAt: at,
        finishedAt: at + 62_000,
      },
      {
        name: "lint",
        run: "bun install --frozen-lockfile && bun run lint",
        kind: "lint",
        coversChange: true,
        status: "notRun",
      },
      {
        name: "rust",
        run: "cargo test --locked",
        kind: "unit",
        coversChange: false,
        status: "notRun",
      },
    ],
  };
};
