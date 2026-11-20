import type { FileImage, ThreadSummary, VerifyState } from "@gram/contracts";

/**
 * A worker's verify recipe as the mock serves it: three drivers passed on the worker's head, one
 * passed only on an older commit and so not run on this one, and one that failed, leaving two
 * screenshots and a video. A thread
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
        evidence: [
          {
            file: "01-tour-start.svg",
            kind: "screenshot",
            caption: "Tour, first step",
            size: 1_200,
          },
          { file: "02-tour-end.svg", kind: "screenshot", caption: "Tour, last step", size: 1_200 },
          { file: "tour.webm", kind: "video", caption: "The whole tour", size: 2_400_000 },
        ],
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

/** A mock screenshot the failed driver left: a drawn frame with its step's name. */
export const mockVerifyEvidence = (driver: string, file: string): FileImage => {
  const step = /^\d+-(.+)\.svg$/.exec(file)?.[1];
  if (driver !== "shots" || step === undefined)
    throw new Error(`No picture ${file} from ${driver}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4f4f5"/><rect width="640" height="36" fill="#e4e4e7"/><rect x="24" y="64" width="180" height="300" rx="8" fill="#e4e4e7"/><rect x="228" y="64" width="388" height="300" rx="8" fill="#ffffff"/><text x="420" y="220" font-family="sans-serif" font-size="24" text-anchor="middle" fill="#52525b">${step}</text></svg>`;
  return {
    path: file,
    mediaType: "image/svg+xml",
    size: svg.length,
    tooLarge: false,
    base64: btoa(svg),
  };
};
