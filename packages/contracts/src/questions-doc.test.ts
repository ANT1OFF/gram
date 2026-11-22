import { describe, expect, it } from "vitest";
import { askQuestion, closeQuestion, markAnswerPending, parseQuestions } from "./questions.ts";
import { readQuestionsEdit, renderStoredQuestions, storedQuestionsOf } from "./questions-doc.ts";

const today = "2026-11-21";

const storeOf = (...asks: string[]) => {
  let content: string | undefined;
  for (const question of asks) {
    const made = askQuestion(content, { question }, today);
    if (!made.ok) throw new Error(made.problem);
    content = made.content;
  }
  return storedQuestionsOf(content, "view");
};

const byId = (content: string) =>
  Object.fromEntries(parseQuestions(content).map((question) => [question.id, question]));

describe("readQuestionsEdit", () => {
  it("reads an added entry as asked and a closed one as closed, keeping the store's ids", () => {
    const stored = storeOf("Which installer ships?", "Who signs the build?");
    const closed = closeQuestion(
      renderStoredQuestions(stored),
      { id: "Q1", answer: "MSI.", how: "decided" },
      today,
    );
    if (!closed.ok) throw new Error(closed.problem);
    const edited = `${closed.content.replace("Who signs the build?", "Who signs the build, and where?")}\n## More questions\n\n- Is arm64 in scope?\n`;
    const reading = readQuestionsEdit(stored, edited);
    expect(reading).toMatchObject({ asked: ["Q3"], closed: ["Q1"], kept: [] });
    const questions = byId(reading.content);
    expect(questions.Q1).toMatchObject({
      open: false,
      closedAs: "decided",
      answer: "MSI.",
    });
    expect(questions.Q2).toMatchObject({
      open: true,
      text: "Who signs the build, and where?",
    });
    expect(questions.Q3).toMatchObject({
      open: true,
      text: "Is arm64 in scope?",
    });
  });

  it("puts back an open question the edit took out, and lets a closed one go", () => {
    const stored = storeOf("Which installer ships?", "Who signs the build?");
    const closed = closeQuestion(
      renderStoredQuestions(stored),
      { id: "Q2", answer: "Release team.", how: "decided" },
      today,
    );
    if (!closed.ok) throw new Error(closed.problem);
    const reading = readQuestionsEdit(storedQuestionsOf(closed.content, "view"), "# Questions\n");
    expect(reading).toMatchObject({ asked: [], closed: [], kept: ["Q1"] });
    expect(Object.keys(byId(reading.content))).toEqual(["Q1"]);
    expect(readQuestionsEdit(stored, undefined).kept).toEqual(["Q1", "Q2"]);
  });

  it("keeps an answer on its way until the edit closes it as answered", () => {
    const pending = markAnswerPending(renderStoredQuestions(storeOf("Which installer ships?")), {
      questionId: "Q1",
      question: "Which installer ships?",
      answer: "MSI.",
      key: "k-123456",
    });
    if (!pending.ok) throw new Error(pending.problem);
    const stored = storedQuestionsOf(pending.content, "view");
    const withdrawn = closeQuestion(
      pending.content,
      { id: "Q1", answer: "Not needed.", how: "withdrawn" },
      today,
    );
    if (!withdrawn.ok) throw new Error(withdrawn.problem);
    const kept = readQuestionsEdit(stored, withdrawn.content);
    expect(kept.closed).toEqual([]);
    expect(byId(kept.content).Q1).toMatchObject({
      open: true,
      pending: "k-123456",
    });

    const answered = readQuestionsEdit(
      stored,
      pending.content
        .replace("## Q1 · open", "## Q1 · answered")
        .replace("Delivery: pending k-123456\n", ""),
    );
    expect(answered.closed).toEqual(["Q1"]);
  });

  it("gives an entry a new id when the one it names is another's", () => {
    const stored = storeOf("Which installer ships?");
    const edited = `${renderStoredQuestions(stored)}\n## Q1 · open\nA second question under the same id?\n`;
    const reading = readQuestionsEdit(stored, edited);
    expect(reading.asked).toEqual(["Q2"]);
    expect(byId(reading.content).Q2?.text).toBe("A second question under the same id?");
  });
});
