import { create } from "zustand";

/** One worker's push answered on its own row of a group's publish box. */
export interface RowAnswer {
  /** Its request's id, which is also its held answer's key in the ask stack. */
  readonly key: string;
  readonly title: string;
  readonly decision: "allow" | "deny";
  /** The group's other requests, whose item shows this answer while any of them is shown. */
  readonly beside: readonly string[];
}

interface RowAnswersState {
  readonly answers: readonly RowAnswer[];
  readonly add: (answer: RowAnswer) => void;
  readonly remove: (key: string) => void;
}

/** What the person answered row by row, so the Inbox says it and offers Undo while it is held. */
export const useRowAnswers = create<RowAnswersState>()((set) => ({
  answers: [],
  add: (answer) =>
    set((s) => ({ answers: [...s.answers.filter((a) => a.key !== answer.key), answer] })),
  remove: (key) => set((s) => ({ answers: s.answers.filter((a) => a.key !== key) })),
}));

/** The row answers to show beside an item that asks `ids`. */
export const rowAnswersBeside = (
  answers: readonly RowAnswer[],
  ids: readonly string[],
): readonly RowAnswer[] => answers.filter((a) => a.beside.some((id) => ids.includes(id)));
