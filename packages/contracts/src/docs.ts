// A workspace's docs: reports, plans and analyses its threads publish with `publish_doc`, kept as
// Markdown in Gram's own state (`<dataDir>/docs/<workspaceId>/`), never in a repo and never
// uploaded. Each is a `<id>.md` file beside a `<id>.json` of what it is: title, the thread that
// wrote it, when, and a revision that every save moves on, so an agent's update can't overwrite
// an edit the user made since it last read the doc. Not claude.ai's Artifacts, which are pages
// uploaded to claude.ai: these stay on this machine.
import * as Schema from "effect/Schema";
import { ThreadId, WorkspaceId } from "./ids.ts";

/**
 * A doc's id: a lowercase slug of its title and a short random tail (`gap-analysis-3f9a2c`). It is
 * also the doc's file name, so nothing but these characters is ever accepted for one, which keeps
 * every doc's files inside its workspace's folder whatever a caller sends.
 */
export const DOC_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const DocId = Schema.String.check(Schema.isPattern(DOC_ID_PATTERN)).pipe(
  Schema.brand("DocId"),
);
export type DocId = typeof DocId.Type;

/** The longest title kept; a longer one is cut at a word. */
export const DOC_TITLE_MAX = 120;
/** The most Markdown one doc may hold, in UTF-8 bytes. */
export const DOC_MAX_BYTES = 256 * 1024;
/** The most docs a workspace keeps; publishing past it is refused until one goes. */
export const DOCS_PER_WORKSPACE_MAX = 200;
/** Characters of a doc's opening prose its card and list row show as a thumbnail. */
export const DOC_EXCERPT_MAX = 280;

/** Who made a doc's last save: its author's agent (or another workspace agent), or the user. */
export const DocEditor = Schema.Literals(["agent", "user"]);
export type DocEditor = typeof DocEditor.Type;

/** What a doc is, without its text. */
export const DocMeta = Schema.Struct({
  id: DocId,
  workspaceId: WorkspaceId,
  title: Schema.String,
  /** The thread that published it first. */
  authorThreadId: ThreadId,
  /** That thread's title when it published, so a closed thread's doc still says who wrote it. */
  authorTitle: Schema.String,
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Epoch ms of the last save, the agent's or the user's. */
  updatedAt: Schema.Number,
  updatedBy: DocEditor,
  /** Starts at 1 and moves on with every save. */
  revision: Schema.Int,
  /** UTF-8 bytes of its Markdown. */
  bytes: Schema.Int,
  /** The opening prose, Markdown stripped, for a card's and a row's thumbnail. */
  excerpt: Schema.String,
});
export type DocMeta = typeof DocMeta.Type;

export const Doc = Schema.Struct({ ...DocMeta.fields, content: Schema.String });
export type Doc = typeof Doc.Type;

/** Newest first by `updatedAt`. */
export const DocList = Schema.Struct({ docs: Schema.Array(DocMeta) });
export type DocList = typeof DocList.Type;

export const DocsListFields = { workspaceId: WorkspaceId };
export const DocReadFields = { workspaceId: WorkspaceId, id: DocId };

/**
 * The user's edit from the doc pane. `revision` is the one the pane opened: a save over a newer
 * one (the agent updated it meanwhile) is refused with `InvalidState`, and the pane says so.
 */
export const DocSaveFields = {
  workspaceId: WorkspaceId,
  id: DocId,
  content: Schema.String,
  revision: Schema.Int,
};

/**
 * The card a `publish_doc` leaves, in the author's transcript and its orchestrator's: which doc,
 * what happened to it, and enough to draw the card without reading the doc.
 */
export const DocCardData = Schema.Struct({
  id: DocId,
  workspaceId: WorkspaceId,
  title: Schema.String,
  authorThreadId: ThreadId,
  authorTitle: Schema.String,
  action: Schema.Literals(["published", "updated"]),
  revision: Schema.Int,
  /** Epoch ms. */
  at: Schema.Number,
  excerpt: Schema.String,
});
export type DocCardData = typeof DocCardData.Type;

/**
 * A doc's opening prose as plain text, for a thumbnail: the first lines that aren't a heading, a
 * fence, a rule or a table's frame, with inline Markdown dropped, cut at `max` characters.
 */
export const docExcerpt = (markdown: string, max = DOC_EXCERPT_MAX): string => {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    // Only a line's start can reach the excerpt, which bounds the work on a long one too.
    const line = raw.slice(0, max * 4).trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line === "" || /^#{1,6}\s/.test(line)) continue;
    // A rule (`---`, `* * *`) or a table's frame (`| --- | :-: |`) says nothing.
    const bare = line.replace(/\s+/g, "");
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(bare) || /^\|?:?-{2,}/.test(bare)) continue;
    // A table row's cells, split rather than matched, so no pattern backtracks over its spaces.
    const cells = line.includes("|")
      ? line
          .split("|")
          .map((cell) => cell.trim())
          .filter((cell) => cell !== "")
          .join(" · ")
      : line;
    const plain = cells
      .replace(/^>\s?/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]+/g, "")
      .trim();
    if (plain === "") continue;
    lines.push(plain);
    if (lines.join(" ").length >= max) break;
  }
  const text = lines.join(" ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** A title cut at a word to `DOC_TITLE_MAX`, with runs of whitespace made one space. */
export const docTitle = (title: string): string => {
  const one = title.replace(/\s+/g, " ").trim();
  if (one.length <= DOC_TITLE_MAX) return one;
  const cut = one.slice(0, DOC_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > DOC_TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
