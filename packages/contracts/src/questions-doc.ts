import * as Schema from "effect/Schema";
import { QuestionChoice, questionsFileParts, type MemoryQuestion } from "./questions.ts";

const { parse, withIds, render, nextId } = questionsFileParts;

type Draft = ReturnType<typeof withIds>[number];

const StoredQuestion = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  open: Schema.Boolean,
  closedAs: Schema.optionalKey(Schema.String),
  date: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(QuestionChoice)),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  recommended: Schema.optionalKey(Schema.String),
  mock: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(Schema.String),
  pending: Schema.optionalKey(Schema.String),
});

/**
 * An orchestrator's questions as the server keeps them, beside its workers' questions: the
 * authority `questions.md` is written from. `view` is the revision of the file as last written
 * (`""` for none), so an edit made to the file since is told from the server's own writes.
 */
export const StoredMemoryQuestions = Schema.Struct({
  preamble: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      question: StoredQuestion,
      source: Schema.Array(Schema.String),
    }),
  ),
  loose: Schema.Array(Schema.Array(Schema.String)),
  view: Schema.String,
});
export type StoredMemoryQuestions = typeof StoredMemoryQuestions.Type;

type StoredEntry = StoredMemoryQuestions["entries"][number];

const storedEntry = ({ question, source }: Draft): StoredEntry => {
  const { detail: _detail, ...rest } = question;
  const kept = Object.entries(rest).filter(([, value]) => value !== undefined);
  return {
    question: Object.fromEntries(kept) as StoredEntry["question"],
    source,
  };
};

const draftOf = ({ question, source }: StoredEntry): Draft => ({
  question: { detail: undefined, ...question },
  source,
});

/** `questions.md` as the store keeps it, every entry given an id; `view` is its revision. */
export const storedQuestionsOf = (
  content: string | undefined,
  view: string,
): StoredMemoryQuestions => {
  const file = parse(content ?? "");
  const entries = withIds(file.entries).map(storedEntry);
  return { preamble: file.preamble, entries, loose: file.loose, view };
};

/** The file the store writes: its text, then the open questions, then the closed ones. */
export const renderStoredQuestions = (stored: StoredMemoryQuestions): string =>
  render({ ...stored, entries: [] }, stored.entries.map(draftOf));

/** The questions the store holds, as `parseQuestions` reads them from the file it writes. */
export const storedQuestionList = (stored: StoredMemoryQuestions): MemoryQuestion[] =>
  stored.entries.map((entry) => draftOf(entry).question);

/** What an edit to the file came to once the store read it. */
export interface QuestionsFileReading {
  /** The file as the store writes it now. */
  readonly content: string;
  /** Questions the edit added, or opened again. */
  readonly asked: readonly string[];
  /** Questions the edit closed. */
  readonly closed: readonly string[];
  /** Open questions the edit took out, which are put back: one waits on the user until closed. */
  readonly kept: readonly string[];
}

const keyOf = (id: string): string => id.toLowerCase();

const mergedEntry = (before: StoredEntry, edited: Draft): Draft => {
  const answeredNow = !edited.question.open && edited.question.closedAs === "answered";
  if (before.question.pending !== undefined && !answeredNow) return draftOf(before);
  return {
    question: { ...edited.question, id: before.question.id },
    source: edited.source,
  };
};

/**
 * An edit made to `questions.md` outside the server's own writes (by a dream, a person, or a
 * memory tool), read against the store: an entry it adds is asked, one it closes is closed, and
 * what it changes in an open one is taken. Ids are the store's: a new entry keeps an id no other
 * entry has, or is given the next free one. An open question the edit took out is put back, since
 * only closing one ends it, and an answer on its way to the orchestrator stays as the store has it
 * until it is closed as answered. A closed question the edit took out is gone.
 */
export const readQuestionsEdit = (
  stored: StoredMemoryQuestions,
  content: string | undefined,
): QuestionsFileReading => {
  const file = parse(content ?? "");
  const known = new Map(stored.entries.map((entry) => [keyOf(entry.question.id), entry]));
  const claimed = new Set<string>();
  const ids: { id: string }[] = stored.entries.map((entry) => ({
    id: entry.question.id,
  }));
  const drafts: Draft[] = [];
  const asked: string[] = [];
  const closed: string[] = [];
  for (const entry of file.entries) {
    const given = entry.question.id;
    const key = given === undefined ? undefined : keyOf(given);
    const before = key === undefined || claimed.has(key) ? undefined : known.get(key);
    if (before === undefined) {
      const free = given !== undefined && !ids.some((each) => keyOf(each.id) === key);
      const id = free ? given : nextId(ids);
      ids.push({ id });
      drafts.push({
        question: { ...entry.question, id },
        source: entry.source,
      });
      if (entry.question.open) asked.push(id);
      continue;
    }
    claimed.add(key!);
    const draft = mergedEntry(before, {
      question: { ...entry.question, id: given! },
      source: entry.source,
    });
    drafts.push(draft);
    if (before.question.open && !draft.question.open) closed.push(draft.question.id);
    if (!before.question.open && draft.question.open) asked.push(draft.question.id);
  }
  const kept: string[] = [];
  for (const entry of stored.entries) {
    if (claimed.has(keyOf(entry.question.id)) || !entry.question.open) continue;
    drafts.push(draftOf(entry));
    kept.push(entry.question.id);
  }
  return { content: render(file, drafts), asked, closed, kept };
};

/**
 * The open questions an edit of `questions.md` asks that the file before it didn't: an entry it
 * adds, or a closed one it opens again. An entry whose id or words were already open is not one.
 */
export const questionsAskedByEdit = (
  before: string | undefined,
  after: string,
): readonly MemoryQuestion[] => {
  const was = parse(before ?? "").entries.map((entry) => entry.question);
  const openIds = new Set(
    was.flatMap((question) =>
      question.open && question.id !== undefined ? [keyOf(question.id)] : [],
    ),
  );
  const openTexts = new Set(
    was.filter((question) => question.open).map((question) => question.text),
  );
  return parse(after)
    .entries.map((entry) => entry.question)
    .filter(
      (question) =>
        question.open &&
        !openTexts.has(question.text) &&
        (question.id === undefined || !openIds.has(keyOf(question.id))),
    );
};
