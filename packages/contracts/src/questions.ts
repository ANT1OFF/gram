// An orchestrator's questions for the user: the entries of its
// memory's `questions.md`, read out of whatever an agent, a dream or a person wrote there, and the
// edits `ask_user`, `close_question` and an answer from the UI make to it. The file is the store:
// the server writes it back in one canonical shape, which this module also reads, so the web app
// and the server share one parser. A leaf: it imports only `ids.ts` and `mock-visuals.ts`.

import * as Schema from "effect/Schema";
import { WorkspaceId } from "./ids.ts";
import {
  isMockImagePath,
  isMockPagePath,
  mockRefKind,
  splitPreviewTarget,
  visualsProblem,
} from "./mock-visuals.ts";

/** The one memory file with a UI meaning. */
export const QUESTIONS_FILE = "questions.md";

export const QUESTION_TEXT_MAX = 300;
export const QUESTION_CONTEXT_MAX = 1_000;
export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 4;
export const QUESTION_LABEL_MAX = 60;
export const QUESTION_DESCRIPTION_MAX = 200;
/** An answer is kept on one line of the file, clipped to this; the message carries all of it. */
export const QUESTION_ANSWER_KEPT = 1_000;

/** How a question was closed by a tool: `answered` is the user's word, the rest the orchestrator's. */
export const QuestionHow = Schema.Literals(["answered", "decided", "withdrawn", "superseded"]);
export type QuestionHow = typeof QuestionHow.Type;

/**
 * One choice a question offers, as `AskUserQuestion` offers them, and what it may show: a
 * screenshot of the direction and the mock page it is drawn on, with the board after a `#`.
 */
export const QuestionChoice = Schema.Struct({
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** A screenshot of this choice: a PNG, JPEG, WebP or GIF in the asking thread's folders. */
  image: Schema.optionalKey(Schema.String),
  /** The mock page that draws it, `…/v1.html#board`, which "Open mock" opens in Preview. */
  preview: Schema.optionalKey(Schema.String),
});
export type QuestionChoice = typeof QuestionChoice.Type;

/** An answer from the UI: to the entry with `questionId`, or, for one without an id, the one reading `question`. */
export const AnswerQuestionInput = Schema.Struct({
  workspaceId: WorkspaceId,
  questionId: Schema.optionalKey(Schema.String),
  question: Schema.String,
  answer: Schema.NonEmptyString,
});
export type AnswerQuestionInput = typeof AnswerQuestionInput.Type;

export const AnswerQuestionResult = Schema.Struct({
  /** The entry's id, which an entry that had none is given when the file is written back. */
  questionId: Schema.String,
  /** How the answer reached the orchestrator. */
  delivered: Schema.Literals(["sent", "queued", "steered"]),
});
export type AnswerQuestionResult = typeof AnswerQuestionResult.Type;

export interface MemoryQuestion {
  /** `Q3`; absent for an entry the orchestrator gave none. */
  readonly id: string | undefined;
  /** The question, on one line. */
  readonly text: string;
  /** What else the entry says: context, a source. */
  readonly detail: string | undefined;
  readonly open: boolean;
  /** The word a closed entry was closed with (`answered`, `decided`, `dropped`, …), lowercased. */
  readonly closedAs?: string | undefined;
  /** The last date on the entry's first line: when it was asked, or closed. */
  readonly date?: string | undefined;
  /** The choices offered, when there are some. */
  readonly options?: readonly QuestionChoice[] | undefined;
  readonly multiSelect?: boolean | undefined;
  /** The label of the choice the orchestrator recommends. */
  readonly recommended?: string | undefined;
  /** The mock the question is about, its `mock.json` or a page: "Open mocks". */
  readonly mock?: string | undefined;
  /** A closed entry's answer or reason; on an open one, an answer on its way (`pending`). */
  readonly answer?: string | undefined;
  /**
   * The key of the user's answer while it is on its way to the orchestrator: the entry is still
   * open, and the answer message carries the key, so a retry can tell whether it got there.
   */
  readonly pending?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Reading

// Every pattern here runs on text an agent or a person wrote, so none may backtrack across a run of
// spaces: a single `\s` before a rest-of-line capture, which the caller trims, and no leading `\s*`
// on a pattern that is searched for rather than anchored (CodeQL's polynomial-regex rule).
const HEADING = /^(#{1,6})\s(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*/;
const ID_TEXT = String.raw`[A-Za-z]{1,4}(?:-[A-Za-z]{1,6})*-?\d{1,5}`;
/** `Q3`, `q-12`, `OQ7`, `Q-C1`, `Q-REL-040`: a few letters and a number, at the head of an entry. */
const ID = new RegExp(String.raw`^[\s*_[(#]*(${ID_TEXT})\b[\s\])*_:.·—–|-]*`);
/** An entry that is a paragraph of its own, led by its id in bold: `**Q1 · …** …`. */
const PARAGRAPH_HEAD = new RegExp(String.raw`^(?:\*\*|__)${ID_TEXT}\b`);
/** What an id given to `ask_user` must look like, so the file reads it back as one. */
export const QUESTION_ID = new RegExp(`^${ID_TEXT}$`);
const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const CLOSED_WORDS =
  "decided|closed|answered|resolved|settled|done|withdrawn|dropped|superseded|obsolete";
const STATUS_WORDS = `${CLOSED_WORDS}|open|opened|reopened`;
const CLOSED_WORD = new RegExp(String.raw`\b(${CLOSED_WORDS})\b`, "i");
const OPEN_WORD = /\bopen\b/i;
const QUESTIONS_WORD = /\bquestions?\b/i;
/** One clause of a status: a word, maybe hedged (`partly answered`), maybe dated. */
const STATUS_CLAUSE = new RegExp(
  String.raw`^(partly\s+|partially\s+)?(${STATUS_WORDS})(?:\s+(?:on\s+)?${DATE})?$`,
  "i",
);
/** A bracketed group at the start of what follows a bold lead. */
const LEAD_BRACKET = /^[[(]([^()[\]]*)[\])]\s*:?/;
/**
 * A status marker: a bracketed group, or a word set off by a separator (`· answered`), so prose using
 * the word isn't one. One pattern for both, so markers are read in the order they are written.
 */
const MARKER = new RegExp(
  String.raw`(?:[[(]([^()[\]]*)[\])]|[·—–|]\s*(${STATUS_WORDS})\b)\s*:?`,
  "gi",
);
/** A body line that records how the entry was closed: `Answer: …`, `Dropped 2026-09-25: …`. */
const CLOSING_LINE = new RegExp(
  String.raw`^(?:(?:answer(?:ed)?|resolved|closed|decided)\b|(?:${CLOSED_WORDS})(?:\s+(?:on\s+)?${DATE})?\s*:)`,
  "i",
);
/** The same line with its answer taken out: `Decided: yes`, `Answered 2026-09-19: web`. */
const ANSWER_LINE = new RegExp(
  String.raw`^(answer|${CLOSED_WORDS})(?:\s+(?:on\s+)?${DATE})?\s*:(.*)$`,
  "i",
);
/** `Q7 · superseded: …`: a status word straight after the id, closed off by a colon. */
const LEADING = new RegExp(String.raw`^(?:${STATUS_WORDS})(?:\s+(?:on\s+)?${DATE})?\s*:`, "i");
const BARE = new RegExp(String.raw`^(?:${STATUS_WORDS})$`, "i");
const DATE_MARKER = new RegExp(String.raw`(?:[·—–|(]\s*)?\b${DATE}\b\)?`, "g");
const DATES = new RegExp(DATE, "g");
const OPTIONS_LINE = /^options\s*\(pick (one|any)\)\s*:?$/i;
const DELIVERY_LINE = /^delivery:\s*pending\s+([A-Za-z0-9-]{4,64})$/i;
const OPTION_MARKER = /^(?:\d+[.)]|[-*+])\s/;
/** A line under a choice naming what it shows: `Image: …/a-inbox-dark.png`, `Preview: …/v1.html#a-inbox`. */
const VISUAL_LINE = /^(image|preview):\s?(.*)$/i;
/** The line naming the mock the question is about: `Mock: …/mock.json`. */
const MOCK_LINE = /^mock:\s?(.*)$/i;

/** A choice's visual line taken apart, when its path is of the kind it names. */
const visualOf = (line: string): { kind: "image" | "preview"; path: string } | undefined => {
  const said = VISUAL_LINE.exec(line);
  if (said === null) return undefined;
  const kind = said[1]!.toLowerCase() === "image" ? "image" : "preview";
  const path = said[2]!.trim();
  const fits =
    kind === "image" ? isMockImagePath(path) : isMockPagePath(splitPreviewTarget(path).path);
  return path !== "" && fits ? { kind, path } : undefined;
};

/** The mock a `Mock:` line names, when it names a `mock.json` or a page. */
const mockOf = (line: string): string | undefined => {
  const path = MOCK_LINE.exec(line)?.[1]?.trim();
  return path !== undefined && path !== "" && mockRefKind(path) !== undefined ? path : undefined;
};
const RECOMMENDED = "(recommended)";
const EDGE = new Set(" \t:·—–|-");

/** `text` without the separators and spaces an id or a marker leaves at its edges. */
const trimEdges = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE.has(text[start]!)) start += 1;
  while (end > start && EDGE.has(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
};

/** A choice's line, `1. Label — description (recommended)`, taken apart by hand rather than by one pattern. */
const optionOf = (
  line: string,
): { label: string; description: string | undefined; recommended: boolean } | undefined => {
  let text = line.replace(OPTION_MARKER, "").trim();
  const recommended = text.toLowerCase().endsWith(RECOMMENDED);
  if (recommended) text = text.slice(0, -RECOMMENDED.length).trim();
  const split = text.indexOf(" — ");
  const label = (split === -1 ? text : text.slice(0, split)).trim();
  const description = split === -1 ? undefined : text.slice(split + 3).trim();
  return label === ""
    ? undefined
    : { label, description: description === "" ? undefined : description, recommended };
};

type Status = "closed" | "open" | "opened";

/**
 * What a bracketed group says of its entry, or `undefined` when it isn't a status: that takes a first
 * clause that is one, as in `(decided 2026-09-25)`, `(OPEN, future idea)` or `(opened 2026-09-22,
 * closed 2026-09-24)`. The last status clause wins, and a hedged one (`partly answered`) is open.
 * `opened` is when the entry was asked, not a claim that it still is, so it is told apart.
 */
const bracketStatus = (inner: string): { status: Status; word: string } | undefined => {
  const clauses = inner.split(/[,;]/).map((clause) => clause.trim());
  if (!STATUS_CLAUSE.test(clauses[0]!)) return undefined;
  let status: Status = "open";
  let word = "open";
  for (const clause of clauses) {
    const said = STATUS_CLAUSE.exec(clause);
    if (said === null) continue;
    word = said[2]!.toLowerCase();
    status =
      said[1] === undefined && CLOSED_WORD.test(word)
        ? "closed"
        : word === "opened"
          ? "opened"
          : "open";
  }
  return { status, word };
};

interface Head {
  readonly id: string | undefined;
  readonly text: string;
  readonly closed: boolean | undefined;
  /** The status word that decided `closed`, when a word did. */
  readonly word: string | undefined;
  readonly date: string | undefined;
  /** What follows a bold lead on its line, which starts the entry's detail. */
  readonly rest: string | undefined;
  /** The bold lead runs on past the end of the line. */
  readonly unclosedBold: boolean;
}

/** An entry's first line taken apart: its id, whether it says open or closed, and what is left. */
const headOf = (raw: string): Head => {
  let text = raw.trim();
  let closed: boolean | undefined;
  let word: string | undefined;
  const box = CHECKBOX.exec(text);
  if (box !== null) {
    closed = box[1] !== " ";
    text = text.slice(box[0].length);
  }
  if (/^~~.*~~$/.test(text)) {
    closed = true;
    text = text.slice(2, -2);
  }
  // `**Q1 · The question?** Opened …`: the bold part is the question, the rest of the line detail.
  let bold = /^(\*\*|__)/.exec(text)?.[1];
  const id = ID.exec(text);
  if (id !== null) {
    const tail = id[0].slice(id[0].indexOf(id[1]!) + id[1]!.length);
    if (bold !== undefined && tail.includes(bold)) bold = undefined;
    text = text.slice(id[0].length);
  } else if (bold !== undefined) {
    text = text.slice(bold.length);
  }
  let rest: string | undefined;
  const end = bold === undefined ? -1 : text.indexOf(bold);
  if (bold !== undefined && end !== -1) {
    rest = text.slice(end + bold.length).trim();
    text = text.slice(0, end);
    const lead = LEAD_BRACKET.exec(rest);
    if (lead !== null && bracketStatus(lead[1]!) !== undefined) {
      text += lead[0];
      rest = rest.slice(lead[0].length).trim();
    }
  }
  const date = text.match(DATES)?.at(-1);
  const leading = id === null ? null : LEADING.exec(text);
  if (leading !== null) {
    closed = CLOSED_WORD.test(leading[0]);
    word = /^[a-z]+/i.exec(leading[0])![0].toLowerCase();
    text = text.slice(leading[0].length);
  }
  // The last status written wins: `(closed 2026-09-20) (reopened 2026-09-25)` is open again.
  text = text.replaceAll(MARKER, (marker, inner: string | undefined, said: string | undefined) => {
    const status =
      inner !== undefined
        ? bracketStatus(inner)
        : {
            status: CLOSED_WORD.test(said!)
              ? ("closed" as const)
              : said!.toLowerCase() === "opened"
                ? ("opened" as const)
                : ("open" as const),
            word: said!.toLowerCase(),
          };
    if (status === undefined) return marker;
    // `opened` dates the entry and says nothing of it now, so the box, the detail or the section decides.
    if (status.status !== "opened") {
      closed = status.status === "closed";
      word = status.word;
    }
    return " ";
  });
  // `## Q1 closed`: a bare status word is a marker only when it is all that is left of the line.
  const bare = text.replace(DATE_MARKER, "").trim();
  if (BARE.test(bare)) {
    closed = CLOSED_WORD.test(bare);
    word = bare.toLowerCase();
    text = "";
  }
  return {
    id: id?.[1],
    text: trimEdges(
      text
        .replaceAll(DATE_MARKER, " ")
        .replaceAll(/\*\*|__/g, "")
        .replaceAll(/\s+/g, " "),
    ),
    closed,
    word,
    date,
    rest: rest === "" ? undefined : rest,
    unclosedBold: bold !== undefined && end === -1,
  };
};

/** One entry as read, with the lines it was read from, so it can be written back in the canonical shape. */
interface ParsedEntry {
  readonly question: MemoryQuestion;
  /** Its detail as written, markers and indentation kept, less what became `options` or `answer`. */
  readonly source: readonly string[];
}

interface ParsedFile {
  /** The file's opening text, before its first entry, less any trailing section headings. */
  readonly preamble: string;
  readonly entries: readonly ParsedEntry[];
  /** What stands after the first entry outside any entry: a heading of the user's and its text. */
  readonly loose: readonly (readonly string[])[];
}

/** An entry's body split into its detail, its offered choices and its recorded answer. */
const structured = (shown: readonly string[], source: readonly string[]) => {
  const detail: string[] = [];
  const kept: string[] = [];
  const options: QuestionChoice[] = [];
  let multiSelect = false;
  let recommended: string | undefined;
  let mock: string | undefined;
  let answer: string | undefined;
  let answerWord: string | undefined;
  let pending: string | undefined;
  let inOptions = false;
  shown.forEach((line, index) => {
    const trimmed = line.trim();
    const head = OPTIONS_LINE.exec(trimmed);
    if (head !== null) {
      inOptions = true;
      multiSelect = head[1]!.toLowerCase() === "any";
      return;
    }
    // A choice is a list item under the options line; anything else ends the list.
    const option = inOptions && LIST_ITEM.test(source[index]!) ? optionOf(trimmed) : undefined;
    if (option !== undefined) {
      options.push({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      });
      if (option.recommended) recommended = option.label;
      return;
    }
    // What a choice shows, on the lines under it, belongs to the last choice and keeps the list going.
    const visual = inOptions && options.length > 0 ? visualOf(trimmed) : undefined;
    if (visual !== undefined) {
      options[options.length - 1] = { ...options.at(-1)!, [visual.kind]: visual.path };
      return;
    }
    if (trimmed !== "") inOptions = false;
    const named = mock === undefined ? mockOf(trimmed) : undefined;
    if (named !== undefined) {
      mock = named;
      return;
    }
    const delivery = DELIVERY_LINE.exec(trimmed);
    if (delivery !== null) {
      pending = delivery[1];
      return;
    }
    const said = answer === undefined ? ANSWER_LINE.exec(trimmed) : null;
    if (said !== null && said[2]!.trim() !== "") {
      answer = said[2]!.trim();
      answerWord = said[1]!.toLowerCase();
      return;
    }
    if (trimmed !== "") detail.push(trimmed);
    kept.push(source[index]!);
  });
  return {
    detail: detail.length === 0 ? undefined : detail.join("\n"),
    kept,
    ...(options.length === 0 ? {} : { options, multiSelect, recommended }),
    mock,
    answer,
    answerWord,
    pending,
  };
};

type EntryKind = "heading" | "item" | "paragraph";

/** Lines with the indentation they share taken off. */
const dedent = (lines: readonly string[]): string[] => {
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== "").map((line) => /^\s*/.exec(line)![0].length),
  );
  return Number.isFinite(indent) ? lines.map((line) => line.slice(indent)) : [...lines];
};

/** The status word a closing line starts with, `Answer` read as `answered`. */
const wordOf = (line: string): string => {
  const word = /^[a-z]+/i.exec(line)![0].toLowerCase();
  return word === "answer" ? "answered" : word;
};

const parseFile = (content: string): ParsedFile => {
  const out: ParsedEntry[] = [];
  const lines = content.split(/\r?\n/);
  let section: boolean | undefined;
  /** Under a heading about questions, or none yet: where a list item without an id is one. */
  let inQuestions = true;
  let firstEntry: number | undefined;
  let entry:
    | {
        raw: string;
        head: Head;
        body: string[];
        source: string[];
        kind: EntryKind;
        /** Under an `Options (pick …):` line, whose numbered items are choices, not entries. */
        options: boolean;
      }
    | undefined;
  const loose: string[][] = [];
  let block: string[] | undefined;
  /** A line after the first entry that no entry holds, kept to be written back as it was. */
  const keep = (line: string) => {
    if (firstEntry === undefined) return;
    if (block === undefined) {
      block = [];
      loose.push(block);
    }
    block.push(line);
  };
  /** A line of the current entry: `shown` is what its detail reads, `line` what is written back. */
  const add = (shown: string, line: string) => {
    if (entry === undefined) return keep(line);
    entry.body.push(shown);
    entry.source.push(line);
    const trimmed = shown.trim();
    if (OPTIONS_LINE.test(trimmed)) entry.options = true;
    else if (trimmed === "" || (!LIST_ITEM.test(line) && visualOf(trimmed) === undefined)) {
      entry.options = false;
    }
  };

  const flush = () => {
    if (entry === undefined) return;
    const shown = [...entry.body];
    // The lines under a list item are indented to it; what followed its bold lead on its own line isn't.
    const source = [
      ...(entry.head.rest === undefined ? [] : [entry.head.rest]),
      ...dedent(entry.source),
    ];
    // A heading that is only an id and a status keeps its question on the line below.
    let text = entry.head.text;
    if (text === "") {
      const first = shown.findIndex((line) => line.trim() !== "");
      if (first !== -1) {
        text = shown[first]!.trim();
        shown.splice(first, 1);
        source.splice(first, 1);
      }
    }
    const said = shown.map((line) => line.trim()).find((line) => CLOSING_LINE.test(line));
    const closed = entry.head.closed ?? (said !== undefined ? true : section);
    if (text !== "") {
      const parts = structured(shown, source);
      const closedAs =
        closed !== true
          ? undefined
          : entry.head.closed === true
            ? (entry.head.word ?? "closed")
            : said === undefined
              ? "closed"
              : wordOf(said);
      out.push({
        question: {
          id: entry.head.id,
          text,
          detail: parts.detail,
          open: closed !== true,
          ...(closedAs === undefined ? {} : { closedAs }),
          ...(entry.head.date === undefined ? {} : { date: entry.head.date }),
          ...(parts.options === undefined
            ? {}
            : {
                options: parts.options,
                multiSelect: parts.multiSelect,
                ...(parts.recommended === undefined ? {} : { recommended: parts.recommended }),
              }),
          ...(parts.mock === undefined ? {} : { mock: parts.mock }),
          ...(parts.answer === undefined ? {} : { answer: parts.answer }),
          ...(parts.pending === undefined ? {} : { pending: parts.pending }),
        },
        source: parts.kept,
      });
    }
    entry = undefined;
  };

  const begin = (index: number, raw: string, kind: EntryKind) => {
    flush();
    firstEntry ??= index;
    block = undefined;
    const head = headOf(raw);
    entry = {
      raw,
      head,
      body: head.rest === undefined ? [] : [head.rest],
      source: [],
      kind,
      options: false,
    };
  };

  let fenced = false;
  lines.forEach((line, index) => {
    // A fence and what is in it is never an entry, but it is written back where it stood.
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      add("", line);
      return;
    }
    if (fenced) {
      add("", line);
      return;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      if (headOf(heading[2]!).id !== undefined) {
        begin(index, heading[2]!, "heading");
      } else {
        block = undefined;
        keep(line);
        // "## Notes" and the like hold the user's own lists, which are kept as they are.
        inQuestions =
          CLOSED_WORD.test(heading[2]!) ||
          OPEN_WORD.test(heading[2]!) ||
          QUESTIONS_WORD.test(heading[2]!);
        // A section heading: "Open", "Closed questions". It sets the default for what is under it.
        section = CLOSED_WORD.test(heading[2]!)
          ? true
          : OPEN_WORD.test(heading[2]!)
            ? false
            : undefined;
      }
      return;
    }
    const item = LIST_ITEM.exec(line);
    if (
      item !== null &&
      item[1]!.length < 2 &&
      entry?.kind !== "heading" &&
      (headOf(item[2]!).id !== undefined ||
        (inQuestions && entry?.kind !== "paragraph" && entry?.options !== true))
    ) {
      begin(index, item[2]!, "item");
      return;
    }
    if (PARAGRAPH_HEAD.test(line) && entry?.kind !== "heading") {
      begin(index, line, "paragraph");
      return;
    }
    if (entry?.head.unclosedBold === true && entry.body.length === 0 && line.trim() !== "") {
      // A bold lead that wraps: `**Q1 · the question` on one line, `goes on?** Detail` on the next.
      const { raw, kind } = entry;
      entry = undefined;
      begin(index, `${raw} ${line.trim()}`, kind);
      return;
    }
    add(item === null ? line : item[2]!, line);
  });
  flush();

  const opening = lines.slice(0, firstEntry ?? lines.length);
  // A section heading at the end of the opening text headed entries that are written back by status.
  for (;;) {
    const last = opening.at(-1);
    if (last === undefined) break;
    const heading = HEADING.exec(last);
    if (last.trim() === "" || (heading !== null && headOf(heading[2]!).id === undefined)) {
      opening.pop();
    } else break;
  }
  // A block that is only a status heading ("## Closed") is said again by each entry's own status.
  const kept = loose.filter((held) =>
    held.some((line) => {
      const heading = HEADING.exec(line);
      return (
        line.trim() !== "" &&
        (heading === null || !(CLOSED_WORD.test(heading[2]!) || OPEN_WORD.test(heading[2]!)))
      );
    }),
  );
  return { preamble: opening.join("\n"), entries: out, loose: kept };
};

/**
 * The entries of a `questions.md`, open and closed. Forgiving on purpose, since an agent writes the
 * file and a person edits it: an entry is a heading that starts with an id (`## Q3 · open`), whose
 * body runs to the next heading; a top-level list item (`- [ ] Q3: …`) under a heading that has
 * none, which without an id counts only under a heading about questions (Open, Closed, Questions);
 * or a paragraph led by a bold id (`**Q3 · …**`), whose list items without an id are its own.
 * It is closed by a ticked box, a struck-through line, a marker such as `(closed)`, `(decided
 * 2026-09-25):` or `· answered`, or by standing under a heading that says so ("## Closed");
 * anything else is open. An `Options (pick one):` list under it is its choices, and an `Answer: …`
 * or `Decided: …` line its answer. Text that fits none of this is ignored, and nothing here throws.
 */
export const parseQuestions = (content: string): MemoryQuestion[] =>
  parseFile(content).entries.map((entry) => entry.question);

export const openQuestions = (content: string | undefined): MemoryQuestion[] =>
  content === undefined ? [] : parseQuestions(content).filter((question) => question.open);

// ---------------------------------------------------------------------------------------------
// Writing

const pad = (n: number): string => String(n).padStart(2, "0");

/** The local calendar date an entry is dated with, `2026-09-25`. */
export const questionDate = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const DEFAULT_PREAMBLE =
  "# Questions for the user\n\nKept by the orchestrator with `ask_user` and `close_question`; an answer from Gram closes its entry.";

const ANSWER_LABEL: Readonly<Record<string, string>> = {
  decided: "Decided",
  withdrawn: "Withdrawn",
  superseded: "Superseded",
  dropped: "Dropped",
  obsolete: "Obsolete",
};

const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Detail lines as written, trimmed of blank edges, with a line that would read as a heading escaped
 * (outside a fence, where it would).
 */
const detailLines = (source: readonly string[]): string[] => {
  const lines = source.map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  let fenced = false;
  return lines
    .filter((line, index) => line !== "" || lines[index - 1] !== "")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      else if (!fenced && /^#{1,6}\s/.test(line)) return `\\${line}`;
      return line;
    });
};

interface Draft {
  readonly question: MemoryQuestion & { readonly id: string };
  readonly source: readonly string[];
}

const renderEntry = ({ question, source }: Draft): string => {
  const date = question.date === undefined ? "" : question.date;
  const status = question.open
    ? `open${date === "" ? "" : ` · ${date}`}`
    : `${question.closedAs ?? "closed"}${date === "" ? "" : ` ${date}`}`;
  const lines = [`## ${question.id} · ${status}`, question.text, ...detailLines(source)];
  if (question.options !== undefined && question.options.length > 0) {
    lines.push(`Options (pick ${question.multiSelect === true ? "any" : "one"}):`);
    question.options.forEach((option, index) => {
      const description = option.description === undefined ? "" : ` — ${option.description}`;
      const recommended = option.label === question.recommended ? " (recommended)" : "";
      lines.push(`${index + 1}. ${option.label}${description}${recommended}`);
      if (option.image !== undefined) lines.push(`   Image: ${option.image}`);
      if (option.preview !== undefined) lines.push(`   Preview: ${option.preview}`);
    });
  }
  if (question.mock !== undefined) lines.push(`Mock: ${question.mock}`);
  if (question.answer !== undefined) {
    lines.push(`${ANSWER_LABEL[question.closedAs ?? ""] ?? "Answer"}: ${question.answer}`);
  }
  if (question.pending !== undefined) lines.push(`Delivery: pending ${question.pending}`);
  return lines.join("\n");
};

/** The next free `Q<n>` past every numbered `Q` id in the file. */
const nextId = (questions: readonly Pick<MemoryQuestion, "id">[]): string => {
  const numbers = questions.flatMap((question) => {
    const match = /^Q(\d+)$/i.exec(question.id ?? "");
    return match === null ? [] : [Number(match[1])];
  });
  return `Q${Math.max(0, ...numbers) + 1}`;
};

/** The file in the canonical shape: its opening text, then the open entries, then the closed ones. */
/**
 * The file in the canonical shape: its opening text, the open entries, the closed ones, then what
 * stood outside any entry (a section of notes, say), as it was written.
 */
const render = (file: ParsedFile, drafts: readonly Draft[]): string => {
  const open = drafts.filter((draft) => draft.question.open);
  const closed = drafts.filter((draft) => !draft.question.open);
  const blocks = [file.preamble.trim() === "" ? DEFAULT_PREAMBLE : file.preamble.trimEnd()];
  for (const draft of [...open, ...closed]) blocks.push(renderEntry(draft));
  for (const lines of file.loose) {
    const text = lines.join("\n").trim();
    if (text !== "") blocks.push(text);
  }
  return `${blocks.join("\n\n")}\n`;
};

/** Every entry with an id, an entry that had none given the next free one. */
const withIds = (entries: readonly ParsedEntry[]): Draft[] => {
  const drafts: Draft[] = [];
  const seen: MemoryQuestion[] = entries.map((entry) => entry.question);
  for (const entry of entries) {
    const id = entry.question.id ?? nextId(seen);
    if (entry.question.id === undefined) seen.push({ ...entry.question, id });
    drafts.push({ question: { ...entry.question, id }, source: entry.source });
  }
  return drafts;
};

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sameText = (a: string, b: string): boolean =>
  oneLine(a).toLowerCase() === oneLine(b).toLowerCase();

export type QuestionEdit =
  | {
      readonly ok: true;
      /** The whole file, rewritten in the canonical shape. */
      readonly content: string;
      readonly id: string;
      /** An entry that was there was changed, rather than one added. */
      readonly updated: boolean;
      /** A closed entry was opened again. */
      readonly reopened: boolean;
    }
  | { readonly ok: false; readonly problem: string };

export interface AskInput {
  readonly id?: string | undefined;
  readonly question: string;
  readonly context?: string | undefined;
  /** Replaces the entry's choices; `[]` takes them away, and leaving it out keeps them. */
  readonly options?: readonly QuestionChoice[] | undefined;
  readonly multiSelect?: boolean | undefined;
  readonly recommended?: string | undefined;
  /** The mock the question is about; `""` takes it away, and leaving it out keeps it. */
  readonly mock?: string | undefined;
}

const no = (problem: string) => ({ ok: false as const, problem });

const askProblem = (input: AskInput): string | undefined => {
  const question = oneLine(input.question);
  if (question === "") return "Say what the question is.";
  if (question.length > QUESTION_TEXT_MAX) {
    return `Keep the question to ${QUESTION_TEXT_MAX} characters, and put the rest in context.`;
  }
  if (input.id !== undefined && !QUESTION_ID.test(input.id)) {
    return `"${input.id}" isn't an id questions.md can hold: a few letters and a number, such as Q7.`;
  }
  if ((input.context ?? "").length > QUESTION_CONTEXT_MAX) {
    return `Keep the context to ${QUESTION_CONTEXT_MAX} characters.`;
  }
  const options = input.options ?? [];
  if (
    options.length > 0 &&
    (options.length < QUESTION_OPTIONS_MIN || options.length > QUESTION_OPTIONS_MAX)
  ) {
    return `Offer ${QUESTION_OPTIONS_MIN} to ${QUESTION_OPTIONS_MAX} options, or none; the user can always answer in their own words.`;
  }
  const labels = options.map((option) => oneLine(option.label));
  if (labels.some((label) => label === "" || label.length > QUESTION_LABEL_MAX)) {
    return `Give every option a label of at most ${QUESTION_LABEL_MAX} characters.`;
  }
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
    return "Give every option a label of its own.";
  }
  if (options.some((option) => (option.description ?? "").length > QUESTION_DESCRIPTION_MAX)) {
    return `Keep each option's description to ${QUESTION_DESCRIPTION_MAX} characters.`;
  }
  if (input.recommended !== undefined && !labels.includes(oneLine(input.recommended))) {
    return "`recommended` has to be one of the options' labels.";
  }
  return visualsProblem(options, input.mock);
};

/** A choice as the file can hold it: on one line, and without the separator its line splits on. */
const choiceOf = (option: QuestionChoice): QuestionChoice => {
  const description = oneLine(option.description ?? "").replaceAll(" (recommended)", "");
  const image = oneLine(option.image ?? "");
  const preview = oneLine(option.preview ?? "");
  return {
    label: oneLine(option.label).replaceAll(" — ", " - "),
    ...(description === "" ? {} : { description }),
    ...(image === "" ? {} : { image }),
    ...(preview === "" ? {} : { preview }),
  };
};

/**
 * `ask_user`: adds a question, or changes the one with `id`, or the open one that reads the same,
 * rather than adding it twice. A closed one asked again is open again. `today` dates what is new.
 */
export const askQuestion = (
  content: string | undefined,
  input: AskInput,
  today: string,
): QuestionEdit => {
  const problem = askProblem(input);
  if (problem !== undefined) return no(problem);
  const file = parseFile(content ?? "");
  const drafts = withIds(file.entries);
  const text = oneLine(input.question);
  const index =
    input.id === undefined
      ? drafts.findIndex((draft) => draft.question.open && sameText(draft.question.text, text))
      : drafts.findIndex((draft) => sameId(draft.question.id, input.id!));
  const before = index === -1 ? undefined : drafts[index];
  const id = before?.question.id ?? input.id ?? nextId(drafts.map((draft) => draft.question));
  const options =
    input.options === undefined ? before?.question.options : input.options.map(choiceOf);
  const hasOptions = options !== undefined && options.length > 0;
  const multiSelect = hasOptions
    ? (input.multiSelect ?? (input.options === undefined ? before?.question.multiSelect : false))
    : undefined;
  const recommended = !hasOptions
    ? undefined
    : input.recommended !== undefined
      ? oneLine(input.recommended)
      : input.options === undefined
        ? before?.question.recommended
        : undefined;
  const source =
    input.context === undefined
      ? (before?.source ?? [])
      : input.context.split(/\r?\n/).map((line) => line.trimEnd());
  const reopened = before !== undefined && !before.question.open;
  const mock = input.mock === undefined ? before?.question.mock : oneLine(input.mock) || undefined;
  const question: Draft["question"] = {
    id,
    text,
    detail: undefined,
    open: true,
    date: before === undefined || reopened ? today : (before.question.date ?? today),
    ...(hasOptions ? { options, multiSelect, recommended } : {}),
    ...(mock === undefined ? {} : { mock }),
    // An answer on its way keeps its key through an update, or a retry would send it again.
    ...(before?.question.open === true && before.question.pending !== undefined
      ? { pending: before.question.pending, answer: before.question.answer }
      : {}),
  };
  const next = [...drafts];
  if (index === -1) next.push({ question, source });
  else next[index] = { question, source };
  return {
    ok: true,
    content: render(file, next),
    id,
    updated: before !== undefined,
    reopened,
  };
};

/**
 * Finds the entry an edit is for: by id when there is one, else by its words, an open entry first.
 * An entry the file gave no id is given one when the file is written back, so the UI's copy of it
 * may still have none.
 */
const find = (
  drafts: readonly Draft[],
  id: string | undefined,
  text: string | undefined,
): number => {
  if (id !== undefined) return drafts.findIndex((draft) => sameId(draft.question.id, id));
  if (text === undefined) return -1;
  const open = drafts.findIndex(
    (draft) => draft.question.open && sameText(draft.question.text, text),
  );
  return open !== -1 ? open : drafts.findIndex((draft) => sameText(draft.question.text, text));
};

const closeAt = (
  file: ParsedFile,
  drafts: Draft[],
  index: number,
  how: string,
  answer: string,
  today: string,
): QuestionEdit => {
  const before = drafts[index]!;
  drafts[index] = {
    // The choices are what was asked; once closed, the answer says which was taken.
    question: {
      id: before.question.id,
      text: before.question.text,
      detail: undefined,
      open: false,
      closedAs: how,
      date: today,
      answer: clip(oneLine(answer), QUESTION_ANSWER_KEPT),
    },
    source: before.source,
  };
  return {
    ok: true,
    content: render(file, drafts),
    id: before.question.id,
    updated: true,
    reopened: false,
  };
};

/** `close_question`: closes the entry with `id`, open or already closed, with its answer or reason. */
export const closeQuestion = (
  content: string | undefined,
  input: { readonly id: string; readonly answer: string; readonly how: QuestionHow },
  today: string,
): QuestionEdit => {
  if (oneLine(input.answer) === "") return no("Say what was decided, or why it no longer matters.");
  const file = parseFile(content ?? "");
  const drafts = withIds(file.entries);
  const index = find(drafts, input.id, undefined);
  if (index === -1) return no(`There is no ${input.id} in ${QUESTIONS_FILE}.`);
  return closeAt(file, drafts, index, input.how, input.answer, today);
};

/**
 * The user's answer from the UI: closes the open entry as `answered`. One that is closed already,
 * by the orchestrator in the meantime say, is refused, so the answer isn't sent for nothing.
 */
export const answerQuestion = (
  content: string | undefined,
  input: {
    readonly questionId?: string | undefined;
    readonly question: string;
    readonly answer: string;
  },
  today: string,
): QuestionEdit => {
  const file = parseFile(content ?? "");
  const drafts = withIds(file.entries);
  const index = find(drafts, input.questionId, input.question);
  const name = input.questionId ?? "That question";
  if (index === -1) return no(`${name} isn't in ${QUESTIONS_FILE} any more.`);
  if (!drafts[index]!.question.open) return no(`${name} is closed already.`);
  return closeAt(file, drafts, index, "answered", input.answer, today);
};

/** The entry an answer is for, with the id the file gives it when it has none, open or closed. */
export const findQuestion = (
  content: string | undefined,
  input: { readonly questionId?: string | undefined; readonly question: string },
): (MemoryQuestion & { readonly id: string }) | undefined => {
  const file = parseFile(content ?? "");
  const drafts = withIds(file.entries);
  return drafts[find(drafts, input.questionId, input.question)]?.question;
};

/** The answer as the file keeps it: on one line, clipped. */
export const keptAnswer = (answer: string): string => clip(oneLine(answer), QUESTION_ANSWER_KEPT);

/**
 * Records the user's answer on its still-open entry, with the key its message will carry, before
 * the message goes: the durable mark that lets a retry find out whether it arrived.
 */
export const markAnswerPending = (
  content: string | undefined,
  input: {
    readonly questionId?: string | undefined;
    readonly question: string;
    readonly answer: string;
    readonly key: string;
  },
): QuestionEdit => {
  const file = parseFile(content ?? "");
  const drafts = withIds(file.entries);
  const index = find(drafts, input.questionId, input.question);
  const name = input.questionId ?? "That question";
  if (index === -1) return no(`${name} isn't in ${QUESTIONS_FILE} any more.`);
  const before = drafts[index]!;
  if (!before.question.open) return no(`${name} is closed already.`);
  drafts[index] = {
    question: { ...before.question, answer: keptAnswer(input.answer), pending: input.key },
    source: before.source,
  };
  return {
    ok: true,
    content: render(file, drafts),
    id: before.question.id,
    updated: true,
    reopened: false,
  };
};

/**
 * The ordinary message an answer reaches the orchestrator as: it quotes
 * the id and the question, and says the entry is closed, so the orchestrator acts on it rather than
 * closing it. `key` is the answer's delivery key, which is how the server finds it in the
 * transcript again.
 */
export const answerMessage = (
  question: { readonly id: string; readonly text: string },
  answer: string,
  key?: string,
): string =>
  `Answer to ${question.id} in ${QUESTIONS_FILE} (“${clip(question.text, 160)}”): ${answer.trim()}\n\n` +
  `Gram has closed ${question.id} as answered. If you need more from the user, ask again with \`ask_user\` and the same id.` +
  (key === undefined ? "" : `\n\n${answerKeyTag(key)}`);

/** How an answer's delivery key is written into its message. */
export const answerKeyTag = (key: string): string => `(answer key ${key})`;
