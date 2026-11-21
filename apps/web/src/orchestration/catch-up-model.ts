const plain = (text: string): string =>
  text
    .replaceAll(/\s+/g, " ")
    .trim()
    .replace(/[.!…]+$/u, "")
    .toLowerCase();

/**
 * Whether the catch-up only says what the worker's last report says, which its view already shows
 * (the transcript's report, a finished worker's Outcome): then it has nothing to add, and the card
 * stays away rather than repeat it above the same words.
 */
export const repeatsReport = (text: string, report: string | undefined): boolean =>
  report !== undefined && plain(report).startsWith(plain(text).replace(/…$/u, ""));
