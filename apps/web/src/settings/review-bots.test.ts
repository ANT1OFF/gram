import { describe, expect, it } from "vitest";

import { validateReviewBots, type ReviewBotDraft } from "./review-bots";

const draft = (loginPattern: string, rereviewCommand = "/agent review", key = loginPattern) =>
  ({ key, loginPattern, rereviewCommand, canApprove: true }) satisfies ReviewBotDraft;

describe("validateReviewBots", () => {
  it("trims valid rows into the bots to save", () => {
    expect(validateReviewBots([draft("  example-code-review[bot] ", " /agent review ")])).toEqual({
      rows: [undefined],
      bots: [
        {
          loginPattern: "example-code-review[bot]",
          rereviewCommand: "/agent review",
          canApprove: true,
        },
      ],
    });
    expect(validateReviewBots([draft("*-review*")]).bots).toHaveLength(1);
    expect(validateReviewBots([]).bots).toEqual([]);
  });

  it("reports the first problem per row and saves nothing", () => {
    const result = validateReviewBots([
      draft(""),
      draft("bad login"),
      draft("copilot[bot]"),
      draft("Copilot", "", "dup"),
      draft("gemini", "/gemini\nreview"),
      draft("sonar", "x".repeat(201)),
    ]);
    expect(result.bots).toBeUndefined();
    expect(result.rows).toEqual([
      "Enter the bot's GitHub login, such as example-code-review[bot].",
      "Use letters, digits, hyphens and * wildcards, optionally ending in [bot].",
      undefined,
      "This login is already listed.",
      "Keep the re-review command to one line of at most 200 characters.",
      "Keep the re-review command to one line of at most 200 characters.",
    ]);
  });

  it("asks for a re-review command", () => {
    expect(validateReviewBots([draft("coderabbitai[bot]", "  ")]).rows).toEqual([
      "Enter the comment that asks for another round, such as /agent review.",
    ]);
  });
});
