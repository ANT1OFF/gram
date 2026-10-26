// Mocks shown as pictures rather than paths (docs/orchestration/playbooks/mock-first.md): the
// screenshot and mock page an option of `ask_user` or `ask_question` may carry, the mock a question
// names, and the card `show_mock` puts in a reply, built from the mock kit's `mock.json` and its
// `shots/`. Every path here was confined to the asking thread's folders by the server before it was
// kept; the web app reads them back through `fs.image` and `fs.preview`, which confine them again,
// and shows only their file names. A leaf: no imports but Schema.

import * as Schema from "effect/Schema";

/** The record the mock kit's `new-mock.mjs` keeps beside a mock's version pages. */
export const MOCK_RECORD = "mock.json";
/** The folder beside it that a mock's screenshots go in. */
export const MOCK_SHOTS = "shots";
/** No more directions than this on one card: a mock is two to four, with their states. */
export const MOCK_DIRECTIONS_MAX = 8;
/** The longest path an option or a question may name. */
export const MOCK_PATH_MAX = 1_024;

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const PAGE = /\.html?$/i;
const BOARD = /^[A-Za-z0-9][\w .·@-]{0,79}$/;

/** `path`'s last segment, the only part of it a card shows. */
export const pathName = (path: string): string => {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
};

/** Whether `path` names a screenshot a card can show: PNG, JPEG, WebP or GIF. */
export const isMockImagePath = (path: string): boolean => IMAGE.test(path.trim());

/** Whether `path` names a mock page, an HTML file. */
export const isMockPagePath = (path: string): boolean => PAGE.test(path.trim());

/**
 * A preview target taken apart: `…/v1.html#c-hybrid-popover` is the page and the board the mock kit
 * focuses for that fragment (a board's id, or its name, which the kit slugs the same way).
 */
export const splitPreviewTarget = (
  target: string,
): { readonly path: string; readonly board: string | undefined } => {
  const trimmed = target.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { path: trimmed, board: undefined };
  const board = trimmed.slice(hash + 1).trim();
  return { path: trimmed.slice(0, hash).trim(), board: board === "" ? undefined : board };
};

/** The page and board as one preview target again. */
export const joinPreviewTarget = (path: string, board: string | undefined): string =>
  board === undefined || board === "" ? path : `${path}#${board}`;

/** The id the mock kit gives a board named `name` (`kit.js` `slug`), which its URL fragment names. */
export const boardSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** What a question's `mock` names: the kit's record, or a page. */
export type MockRefKind = "record" | "page";

export const mockRefKind = (path: string): MockRefKind | undefined =>
  pathName(path).toLowerCase() === MOCK_RECORD
    ? "record"
    : isMockPagePath(splitPreviewTarget(path).path)
      ? "page"
      : undefined;

/** An option's pictures as `ask_user` and `ask_question` take them. */
export interface ChoiceVisuals {
  readonly label: string;
  readonly image?: string | undefined;
  readonly preview?: string | undefined;
}

/**
 * Why the visuals of a question are refused, by their shape alone, in words the agent can act on;
 * `undefined` when they are fine. Where they are is the server's to check, against the asking
 * thread's folders.
 */
export const visualsProblem = (
  options: ReadonlyArray<ChoiceVisuals>,
  mock: string | undefined,
): string | undefined => {
  for (const option of options) {
    const name = option.label.trim();
    if (option.image !== undefined) {
      const image = option.image.trim();
      if (image.length > MOCK_PATH_MAX) return `Keep ${name}'s image path shorter.`;
      if (image !== "" && !isMockImagePath(image)) {
        return `${name}'s image has to be a PNG, JPEG, WebP or GIF screenshot: ${pathName(image)} isn't one.`;
      }
    }
    if (option.preview !== undefined) {
      const preview = option.preview.trim();
      if (preview.length > MOCK_PATH_MAX) return `Keep ${name}'s preview path shorter.`;
      if (preview === "") continue;
      const { path, board } = splitPreviewTarget(preview);
      if (!isMockPagePath(path)) {
        return `${name}'s preview has to be a mock page, an HTML file, with an optional #board: ${pathName(path)} isn't one.`;
      }
      if (board !== undefined && !BOARD.test(board)) {
        return `${name}'s board after the # has to be a board's id or name, such as c-hybrid-popover.`;
      }
    }
  }
  if (mock !== undefined && mock.trim() !== "") {
    if (mock.trim().length > MOCK_PATH_MAX) return "Keep the mock's path shorter.";
    if (mockRefKind(mock) === undefined) {
      return `\`mock\` has to be a mock's ${MOCK_RECORD} or one of its HTML pages: ${pathName(mock)} is neither.`;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------
// The mock card

/** A direction's screenshots, by the theme they were taken in. */
export const MockShots = Schema.Struct({
  dark: Schema.optionalKey(Schema.String),
  light: Schema.optionalKey(Schema.String),
});
export type MockShots = typeof MockShots.Type;

export const MockDirection = Schema.Struct({
  name: Schema.String,
  /** The board Open in Preview focuses, by the id the kit gives it. */
  board: Schema.optionalKey(Schema.String),
  shots: MockShots,
});
export type MockDirection = typeof MockDirection.Type;

/** What `show_mock` puts in a reply: the `mock` data part. Paths are absolute and confined. */
export const MockCardData = Schema.Struct({
  title: Schema.String,
  slug: Schema.optionalKey(Schema.String),
  /** `draft`, `in-review` or `approved`, as `mock.json` says. */
  status: Schema.optionalKey(Schema.String),
  /** The version the card shows, and the approved one when there is one. */
  version: Schema.optionalKey(Schema.Number),
  approved: Schema.optionalKey(Schema.Number),
  /** The version page Open in Preview opens. */
  page: Schema.String,
  /** The mock's `mock.json`, when it has one. */
  record: Schema.optionalKey(Schema.String),
  directions: Schema.Array(MockDirection),
});
export type MockCardData = typeof MockCardData.Type;

/** `mock.json` as read: whatever of it is well formed. */
export interface MockRecord {
  readonly title: string | undefined;
  readonly slug: string | undefined;
  readonly status: string | undefined;
  readonly current: number | undefined;
  readonly approved: number | undefined;
  readonly versions: ReadonlyArray<{ readonly n: number; readonly file: string }>;
  /** Named directions with their shots, relative to the mock's folder; absent to read `shots/`. */
  readonly directions:
    | ReadonlyArray<{
        readonly name: string;
        readonly board: string | undefined;
        readonly shots: { readonly dark?: string; readonly light?: string };
      }>
    | undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** `mock.json`'s fields, forgiving of what an agent or a person left out; `undefined` if not JSON. */
export const parseMockRecord = (content: string): MockRecord | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const versions = (Array.isArray(record["versions"]) ? record["versions"] : []).flatMap(
    (version: unknown) => {
      if (typeof version !== "object" || version === null) return [];
      const n = count(Reflect.get(version, "n"));
      const file = text(Reflect.get(version, "file"));
      return n === undefined || file === undefined || !isMockPagePath(file) ? [] : [{ n, file }];
    },
  );
  const directions = Array.isArray(record["directions"])
    ? record["directions"].flatMap((direction: unknown) => {
        if (typeof direction !== "object" || direction === null) return [];
        const name = text(Reflect.get(direction, "name"));
        if (name === undefined) return [];
        const shots: unknown = Reflect.get(direction, "shots");
        const shot = (theme: "dark" | "light") => {
          const path =
            typeof shots === "object" && shots !== null
              ? text(Reflect.get(shots, theme))
              : undefined;
          return path !== undefined && isMockImagePath(path) ? { [theme]: path } : {};
        };
        return [
          {
            name,
            board: text(Reflect.get(direction, "board")),
            shots: { ...shot("dark"), ...shot("light") },
          },
        ];
      })
    : undefined;
  return {
    title: text(record["title"]),
    slug: text(record["slug"]),
    status: text(record["status"]),
    current: count(record["current"]),
    approved: count(record["approved"]),
    versions,
    directions,
  };
};

const THEMED = /^(.*?)[-_.](dark|light)$/i;

/** `a-inbox-empty` as a card names it: "A inbox empty". */
const directionName = (stem: string): string => {
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words === "" ? stem : `${words[0]!.toUpperCase()}${words.slice(1)}`;
};

/**
 * Directions read from the file names in `shots/`, for a `mock.json` that names none: one per
 * name, with `-dark` and `-light` ones paired (`c-popover-dark.png`, `c-popover-light.png`), in
 * name order, at most `MOCK_DIRECTIONS_MAX`. A shot with no theme in its name is the light one.
 */
export const directionsFromShots = (
  names: ReadonlyArray<string>,
): Array<{ readonly name: string; readonly shots: { dark?: string; light?: string } }> => {
  const byStem = new Map<string, { dark?: string; light?: string }>();
  for (const name of names.toSorted()) {
    if (!isMockImagePath(name) || name.startsWith(".")) continue;
    const stem = name.slice(0, name.lastIndexOf("."));
    const themed = THEMED.exec(stem);
    const key = themed?.[1] ?? stem;
    const theme = themed?.[2]?.toLowerCase() === "dark" ? "dark" : "light";
    const shots = byStem.get(key) ?? {};
    shots[theme] ??= name;
    byStem.set(key, shots);
  }
  return [...byStem]
    .slice(0, MOCK_DIRECTIONS_MAX)
    .map(([stem, shots]) => ({ name: directionName(stem), shots }));
};

/** The shot a card shows for `theme`, or the other one when that is all there is. */
export const shotFor = (shots: MockShots, theme: "dark" | "light"): string | undefined =>
  shots[theme] ?? (theme === "dark" ? shots.light : shots.dark);
