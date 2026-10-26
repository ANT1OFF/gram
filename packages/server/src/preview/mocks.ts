// Mocks as pictures (docs/orchestration/playbooks/mock-first.md): the paths a question's options
// and `show_mock` name are confined to the asking thread's folders, its checkouts, before anything
// is kept or shown, so a card can't be made into a viewer for any file on the machine. The web app
// then reads them through `fs.image` and `fs.preview`, which hold them to the same folders again.

import {
  isCredentialPath,
  isMockImagePath,
  isMockPagePath,
  joinPreviewTarget,
  MOCK_DIRECTIONS_MAX,
  MOCK_RECORD,
  MOCK_SHOTS,
  directionsFromShots,
  mockRefKind,
  parseMockRecord,
  pathName,
  splitPreviewTarget,
  visualsProblem,
  type MockCardData,
  type MockDirection,
  type QuestionChoice,
} from "@gram/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveScopedIn } from "../fs/files.ts";

/** Why a mock or a picture can't be shown, in words the agent can act on. */
export class MockRefused extends Data.TaggedError("MockRefused")<{ readonly message: string }> {}

const refuse = (message: string) => new MockRefused({ message });

/** The longest `mock.json` read: a record of versions, not a document. */
const RECORD_MAX_BYTES = 64 * 1024;

type Want = "file" | "dir";

/**
 * `input` as a path inside one of `roots`: a relative one against the first, an absolute one
 * against the root that holds it, lexically and through every link (`resolveScopedIn`), never a
 * file that may hold credentials, and of the kind `want` names. The path is kept as resolved, not
 * as its real path, so the checks that read it later see it inside the same roots.
 */
export const confinedPath = (
  input: string,
  roots: ReadonlyArray<string>,
  want: Want = "file",
): Effect.Effect<string, MockRefused> =>
  Effect.gen(function* () {
    const name = pathName(input) || input.trim();
    const target = yield* resolveScopedIn(input, roots).pipe(
      Effect.mapError((error) =>
        error._tag === "NotFound"
          ? refuse(`${name} doesn't exist`)
          : refuse(
              `${name} is outside this thread's folders: show pictures and mocks from its own worktree or repo`,
            ),
      ),
    );
    if (isCredentialPath(target)) return yield* refuse(`${name} may hold credentials`);
    const info = yield* Effect.tryPromise({
      try: () => stat(target),
      catch: () => refuse(`${name} doesn't exist`),
    });
    if (want === "file" && !info.isFile()) return yield* refuse(`${name} isn't a file`);
    if (want === "dir" && !info.isDirectory()) return yield* refuse(`${name} isn't a folder`);
    return target;
  });

/** A page and its board, the page confined and the board kept as it was given. */
const confinedTarget = (target: string, roots: ReadonlyArray<string>) => {
  const { path, board } = splitPreviewTarget(target);
  return confinedPath(path, roots).pipe(Effect.map((page) => joinPreviewTarget(page, board)));
};

const given = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

/**
 * A question's options and mock with every path confined to `roots` and made absolute, for
 * `ask_user` and `ask_question`; a path of the wrong kind or outside them refuses the question.
 * What was left out stays out, and an empty `mock` stays empty, which takes the mock away.
 */
export const confineQuestionVisuals = <
  I extends {
    readonly options?: ReadonlyArray<QuestionChoice> | undefined;
    readonly mock?: string | undefined;
  },
>(
  input: I,
  roots: ReadonlyArray<string>,
): Effect.Effect<I, MockRefused> =>
  Effect.gen(function* () {
    const problem = visualsProblem(input.options ?? [], input.mock);
    if (problem !== undefined) return yield* refuse(problem);
    const options =
      input.options === undefined
        ? undefined
        : yield* Effect.forEach(input.options, (option) =>
            Effect.gen(function* () {
              const { image: _image, preview: _preview, ...rest } = option;
              const image = given(option.image);
              const preview = given(option.preview);
              return {
                ...rest,
                ...(image === undefined ? {} : { image: yield* confinedPath(image, roots) }),
                ...(preview === undefined
                  ? {}
                  : { preview: yield* confinedTarget(preview, roots) }),
              };
            }),
          );
    const mock = given(input.mock);
    return {
      ...input,
      ...(options === undefined ? {} : { options }),
      ...(input.mock === undefined
        ? {}
        : { mock: mock === undefined ? "" : yield* confinedTarget(mock, roots) }),
    };
  });

/** The pictures in a mock's `shots/`, by file name; none when it has no such folder. */
const shotNames = (folder: string) =>
  Effect.promise(() =>
    readdir(join(folder, MOCK_SHOTS), { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      () => [] as string[],
    ),
  );

/** A path inside the mock's folder that `confinedPath` allows, or nothing: a card skips it. */
const optional = (path: string, roots: ReadonlyArray<string>) =>
  confinedPath(path, roots).pipe(
    Effect.map((confined): string | undefined => confined),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * `show_mock`'s card for the mock `input` names: its `mock.json`, its folder, or one of its version
 * pages, inside `roots`. The card shows the version asked for, else the page given, else the
 * current version, with a direction per entry of the record's `directions` or, without them, per
 * name in `shots/`, dark and light paired. Every path on it is confined; a shot that isn't is left
 * off rather than refusing the card.
 */
export const mockCard = (
  input: string,
  roots: ReadonlyArray<string>,
  version?: number,
): Effect.Effect<MockCardData, MockRefused> =>
  Effect.gen(function* () {
    const trimmed = splitPreviewTarget(input).path;
    const kind = mockRefKind(trimmed);
    const folder =
      kind === undefined
        ? yield* confinedPath(trimmed, roots, "dir")
        : dirname(yield* confinedPath(trimmed, roots));
    const recordPath = yield* optional(join(folder, MOCK_RECORD), roots);
    const content =
      recordPath === undefined
        ? undefined
        : yield* Effect.promise(() =>
            stat(recordPath).then(
              (info) => (info.size > RECORD_MAX_BYTES ? undefined : readFile(recordPath, "utf8")),
              () => undefined,
            ),
          );
    const record = content === undefined ? undefined : parseMockRecord(content);
    if (kind === "record" && record === undefined) {
      return yield* refuse(`${MOCK_RECORD} in ${pathName(folder)} isn't readable JSON`);
    }
    const versions = record?.versions ?? [];
    const asked = version === undefined ? undefined : versions.find((each) => each.n === version);
    if (version !== undefined && asked === undefined) {
      return yield* refuse(`${pathName(folder)} has no version ${version} in its ${MOCK_RECORD}`);
    }
    const pageGiven = kind === "page" ? trimmed : undefined;
    const pageFile =
      asked?.file ??
      (pageGiven === undefined
        ? (versions.find((each) => each.n === record?.current) ?? versions.at(-1))?.file
        : undefined);
    const page =
      pageFile === undefined
        ? pageGiven === undefined
          ? undefined
          : yield* confinedPath(pageGiven, roots)
        : yield* confinedPath(join(folder, pageFile), roots);
    if (page === undefined || !isMockPagePath(page)) {
      return yield* refuse(
        `${pathName(folder)} has no version page to open: give its ${MOCK_RECORD} versions, or a page`,
      );
    }
    const shown = versions.find((each) => join(folder, each.file) === page)?.n;

    const named = record?.directions;
    const planned: Array<{
      name: string;
      board?: string | undefined;
      shots: Record<string, string>;
    }> =
      named === undefined
        ? directionsFromShots(yield* shotNames(folder)).map((direction) => ({
            name: direction.name,
            shots: Object.fromEntries(
              Object.entries(direction.shots).map(([theme, name]) => [
                theme,
                join(folder, MOCK_SHOTS, name),
              ]),
            ),
          }))
        : named.slice(0, MOCK_DIRECTIONS_MAX).map((direction) => ({
            name: direction.name,
            board: direction.board,
            shots: Object.fromEntries(
              Object.entries(direction.shots).map(([theme, path]) => [theme, join(folder, path)]),
            ),
          }));
    const directions: MockDirection[] = [];
    for (const direction of planned) {
      const shots: { dark?: string; light?: string } = {};
      for (const theme of ["dark", "light"] as const) {
        const path = direction.shots[theme];
        if (path === undefined || !isMockImagePath(path)) continue;
        const confined = yield* optional(path, roots);
        if (confined !== undefined) shots[theme] = confined;
      }
      directions.push({
        name: direction.name,
        ...(direction.board === undefined ? {} : { board: direction.board }),
        shots,
      });
    }
    return {
      title: record?.title ?? pathName(folder),
      ...(record?.slug === undefined ? {} : { slug: record.slug }),
      ...(record?.status === undefined ? {} : { status: record.status }),
      ...(shown === undefined ? {} : { version: shown }),
      ...(record?.approved === undefined ? {} : { approved: record.approved }),
      page,
      ...(recordPath === undefined || record === undefined ? {} : { record: recordPath }),
      directions,
    };
  });
