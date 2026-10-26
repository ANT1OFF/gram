import type { ReviewBot } from "@gram/contracts";

export interface ReviewBotDraft {
  /** Local key for list rendering; not saved. */
  readonly key: string;
  readonly loginPattern: string;
  readonly rereviewCommand: string;
  readonly canApprove: boolean;
}

/** A GitHub login with `*` wildcards, optionally ending in `[bot]`. */
const LOGIN_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9*-]*(\[bot\])?$/;
const MAX_COMMAND_LENGTH = 200;

const loginKey = (pattern: string) => pattern.toLowerCase().replace(/\[bot\]$/, "");

export interface ReviewBotsValidation {
  /** The first problem per row, or `undefined` for a valid row. */
  readonly rows: ReadonlyArray<string | undefined>;
  /** The bots to save, trimmed; absent while any row has a problem. */
  readonly bots?: ReadonlyArray<ReviewBot>;
}

/** Checks the editor's rows before `settings.reviewBots` is saved. */
export function validateReviewBots(drafts: ReadonlyArray<ReviewBotDraft>): ReviewBotsValidation {
  const seen = new Set<string>();
  const bots = drafts.map((draft) => ({
    loginPattern: draft.loginPattern.trim(),
    rereviewCommand: draft.rereviewCommand.trim(),
    canApprove: draft.canApprove,
  }));
  const rows = bots.map((bot) => {
    if (bot.loginPattern === "") {
      return "Enter the bot's GitHub login, such as example-code-review[bot].";
    }
    if (!LOGIN_PATTERN.test(bot.loginPattern)) {
      return "Use letters, digits, hyphens and * wildcards, optionally ending in [bot].";
    }
    const key = loginKey(bot.loginPattern);
    if (seen.has(key)) return "This login is already listed.";
    seen.add(key);
    if (bot.rereviewCommand === "") {
      return "Enter the comment that asks for another round, such as /agent review.";
    }
    if (/[\r\n]/.test(bot.rereviewCommand) || bot.rereviewCommand.length > MAX_COMMAND_LENGTH) {
      return `Keep the re-review command to one line of at most ${MAX_COMMAND_LENGTH} characters.`;
    }
    return undefined;
  });
  return rows.every((row) => row === undefined) ? { rows, bots } : { rows };
}
