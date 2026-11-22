import { AppToolError, questionsAskedByEdit } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { refusal } from "./rules.ts";

/**
 * Refuses a memory tool's edit of `questions.md` that puts an open question in it: every open
 * entry waits on the user in the Inbox, so a model asks with `ask_user`, and a recap of answered
 * questions written there would read as a new ask.
 */
export const noQuestionsAsked = (tool: string, before: string | undefined, after: string) => {
  const asked = questionsAskedByEdit(before, after);
  if (asked.length === 0) return Effect.void;
  const named = asked.map((question) => `"${question.text.slice(0, 80)}"`).join(", ");
  return Effect.fail(
    new AppToolError({
      tool,
      message: refusal(
        "not_allowed",
        `Nothing was written: this ${tool} would put an open question in questions.md (${named}), and every open entry there waits on the user in the Inbox. Ask with \`ask_user\` and settle one with \`close_question\`. A recap or log of questions already answered belongs in another note, such as decisions.md.`,
      ),
    }),
  );
};
