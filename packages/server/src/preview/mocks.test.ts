import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinedPath, confineQuestionVisuals, mockCard } from "./mocks.ts";

// The needs-you-home mock as the design-brief worker left it in its worktree: mock.json, one
// version, and thirteen screenshots in shots/, dark and light.
const SHOTS = [
  "a-inbox-dark.png",
  "a-inbox-empty-dark.png",
  "a-inbox-light.png",
  "b-landed-dark.png",
  "b-landed-light.png",
  "b-popover-dark.png",
  "b-popover-empty-light.png",
  "b-popover-light.png",
  "c-panel-dark.png",
  "c-panel-empty-light.png",
  "c-panel-light.png",
  "c-popover-dark.png",
  "c-popover-light.png",
];
const RECORD = {
  title: "Needs you home",
  slug: "needs-you-home",
  status: "approved",
  template: "options",
  current: 1,
  approved: 1,
  versions: [{ n: 1, file: "v1.html", created: "2026-10-19" }],
};

const setup = Effect.gen(function* () {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-mocks-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const repo = join(dir, "repo");
  const worktree = join(repo, ".worktrees", "feat-needs-you-home");
  const mock = join(worktree, "docs", "design", "mocks", "needs-you-home");
  mkdirSync(join(mock, "shots"), { recursive: true });
  writeFileSync(join(mock, "mock.json"), JSON.stringify(RECORD));
  writeFileSync(join(mock, "v1.html"), "<!doctype html><body class=mock>");
  writeFileSync(join(mock, "brief.md"), "# Needs you home\n");
  for (const shot of SHOTS) writeFileSync(join(mock, "shots", shot), "png");
  // What sits outside: a screenshot in the temp folder, the repo's .env, and a link out.
  const outside = join(dir, "elsewhere.png");
  writeFileSync(outside, "png");
  writeFileSync(join(repo, ".env"), "TOKEN=x");
  symlinkSync(outside, join(mock, "shots", "linked-dark.png"));
  return { dir, repo, worktree, mock, outside };
});

const refusal = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message);

describe("confinedPath", () => {
  it.effect("takes a file in the thread's folders, relative or absolute, as resolved", () =>
    Effect.gen(function* () {
      const { repo, worktree, mock } = yield* setup;
      const shot = join(mock, "shots", "a-inbox-dark.png");
      expect(
        yield* confinedPath("docs/design/mocks/needs-you-home/shots/a-inbox-dark.png", [worktree]),
      ).toBe(shot);
      expect(yield* confinedPath(shot, [worktree])).toBe(shot);
      // The orchestrator's checkout is the repo, which holds its workers' worktrees.
      expect(yield* confinedPath(shot, [repo])).toBe(shot);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses what is outside, behind a link, missing, a folder or a credential", () =>
    Effect.gen(function* () {
      const { repo, worktree, mock, outside } = yield* setup;
      expect(yield* refusal(confinedPath(outside, [worktree]))).toBe(
        "elsewhere.png is outside this thread's folders: show pictures and mocks from its own worktree or repo",
      );
      expect(yield* refusal(confinedPath("../../elsewhere.png", [worktree]))).toMatch(/outside/);
      expect(
        yield* refusal(confinedPath(join(mock, "shots", "linked-dark.png"), [worktree])),
      ).toMatch(/linked-dark.png is outside/);
      expect(yield* refusal(confinedPath(join(mock, "nope.png"), [worktree]))).toBe(
        "nope.png doesn't exist",
      );
      expect(yield* refusal(confinedPath(mock, [worktree]))).toBe("needs-you-home isn't a file");
      expect(yield* refusal(confinedPath(join(repo, ".env"), [repo]))).toBe(
        ".env may hold credentials",
      );
      expect(yield* refusal(confinedPath(outside, []))).toMatch(/outside/);
    }).pipe(Effect.scoped),
  );
});

describe("confineQuestionVisuals", () => {
  it.effect("makes each option's image and preview, and the mock, absolute", () =>
    Effect.gen(function* () {
      const { worktree, mock } = yield* setup;
      const folder = "docs/design/mocks/needs-you-home";
      const confined = yield* confineQuestionVisuals(
        {
          question: "Which direction?",
          options: [
            {
              label: "A Inbox",
              image: `${folder}/shots/a-inbox-dark.png`,
              preview: `${folder}/v1.html#a-inbox`,
            },
            { label: "B Jump", description: "No pictures" },
          ],
          mock: `${folder}/mock.json`,
        },
        [worktree],
      );
      expect(confined).toEqual({
        question: "Which direction?",
        options: [
          {
            label: "A Inbox",
            image: join(mock, "shots", "a-inbox-dark.png"),
            preview: `${join(mock, "v1.html")}#a-inbox`,
          },
          { label: "B Jump", description: "No pictures" },
        ],
        mock: join(mock, "mock.json"),
      });
      // An empty mock stays empty, which takes it away.
      expect(yield* confineQuestionVisuals({ mock: "" }, [worktree])).toEqual({ mock: "" });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses the question when any of them is outside or of the wrong kind", () =>
    Effect.gen(function* () {
      const { worktree, mock, outside } = yield* setup;
      expect(
        yield* refusal(
          confineQuestionVisuals({ options: [{ label: "A", image: outside }, { label: "B" }] }, [
            worktree,
          ]),
        ),
      ).toMatch(/elsewhere.png is outside this thread's folders/);
      expect(
        yield* refusal(
          confineQuestionVisuals({ options: [{ label: "A", preview: "/etc/passwd.html" }] }, [
            worktree,
          ]),
        ),
      ).toMatch(/outside this thread's folders/);
      expect(
        yield* refusal(confineQuestionVisuals({ mock: join(mock, "brief.md") }, [worktree])),
      ).toMatch(/`mock` has to be a mock's mock.json/);
    }).pipe(Effect.scoped),
  );
});

describe("mockCard", () => {
  it.effect("builds the card from mock.json and shots/, pairing dark with light", () =>
    Effect.gen(function* () {
      const { worktree, mock } = yield* setup;
      const card = yield* mockCard("docs/design/mocks/needs-you-home/mock.json", [worktree]);
      expect(card).toMatchObject({
        title: "Needs you home",
        slug: "needs-you-home",
        status: "approved",
        version: 1,
        approved: 1,
        page: join(mock, "v1.html"),
        record: join(mock, "mock.json"),
      });
      expect(card.directions.map((direction) => direction.name)).toEqual([
        "A inbox",
        "A inbox empty",
        "B landed",
        "B popover",
        "B popover empty",
        "C panel",
        "C panel empty",
        "C popover",
      ]);
      expect(card.directions[0]!.shots).toEqual({
        dark: join(mock, "shots", "a-inbox-dark.png"),
        light: join(mock, "shots", "a-inbox-light.png"),
      });
      // The shot that links out of the worktree is left off, and the rest still show.
      expect(JSON.stringify(card)).not.toContain("elsewhere");
      // The folder and a page name the same mock.
      expect((yield* mockCard(mock, [worktree])).page).toBe(join(mock, "v1.html"));
      expect((yield* mockCard(join(mock, "v1.html#c-panel"), [worktree])).version).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("follows the directions mock.json names, with their boards", () =>
    Effect.gen(function* () {
      const { worktree, mock } = yield* setup;
      writeFileSync(
        join(mock, "mock.json"),
        JSON.stringify({
          ...RECORD,
          directions: [
            {
              name: "C Hybrid",
              board: "c-hybrid-popover",
              shots: { dark: "shots/c-popover-dark.png", light: "shots/c-popover-light.png" },
            },
            { name: "Escapee", shots: { dark: "../../../../../../elsewhere.png" } },
          ],
        }),
      );
      const card = yield* mockCard(mock, [worktree]);
      expect(card.directions).toEqual([
        {
          name: "C Hybrid",
          board: "c-hybrid-popover",
          shots: {
            dark: join(mock, "shots", "c-popover-dark.png"),
            light: join(mock, "shots", "c-popover-light.png"),
          },
        },
        { name: "Escapee", shots: {} },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a mock outside the thread's folders, or one with nothing to open", () =>
    Effect.gen(function* () {
      const { dir, worktree, mock } = yield* setup;
      const other = join(dir, "other-repo");
      mkdirSync(other);
      expect(yield* refusal(mockCard(join(mock, "mock.json"), [other]))).toMatch(
        /mock.json is outside this thread's folders/,
      );
      expect(yield* refusal(mockCard(mock, [worktree], 4))).toBe(
        "needs-you-home has no version 4 in its mock.json",
      );
      writeFileSync(join(mock, "mock.json"), "{ not json");
      expect(yield* refusal(mockCard(join(mock, "mock.json"), [worktree]))).toBe(
        "mock.json in needs-you-home isn't readable JSON",
      );
      expect(yield* refusal(mockCard(join(mock, "brief.md"), [worktree]))).toBe(
        "brief.md isn't a folder",
      );
    }).pipe(Effect.scoped),
  );
});
