/** Rows of body text a banner shows before it cuts the rest. */
export const NOTICE_BODY_ROWS = 2;
/** Characters a body row holds, estimated low: wide characters count twice. */
export const NOTICE_ROW_CHARS = 38;
/** What a body says after a command it couldn't show whole. */
export const NOTICE_CUT_LINE = "Cut short. Open to review.";

/** The action labels a notification may carry besides opening it. */
export const NOTICE_ACTIONS = ["Allow", "Merge"] as const;
export type NoticeAction = (typeof NOTICE_ACTIONS)[number];

const HIDING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\p{Extended_Pictographic}]/u;

/** Whether one line reads as written: no character in it hides, reorders or breaks the rest. */
export const noticePlain = (line: string): boolean => !HIDING.test(line);

const columns = (line: string): number => {
  let n = 0;
  for (const char of line) n += WIDE.test(char) ? 2 : 1;
  return n;
};

/** The banner rows `body` wraps to, its lines split on `\n`. */
export const noticeRows = (body: string): number =>
  body
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(columns(line) / NOTICE_ROW_CHARS)), 0);

/**
 * Whether `body` is shown whole: every line plain and all of it within the banner's rows. Only a
 * body that fits may carry an Allow or Merge.
 */
export const noticeBodyFits = (body: string): boolean =>
  body.split("\n").every(noticePlain) && noticeRows(body) <= NOTICE_BODY_ROWS;

/** The label of an action that answers, exactly: "Allow", "Allow 3" or "Merge". */
export const isNoticeActionLabel = (label: unknown): label is string =>
  typeof label === "string" && /^(?:Allow(?: [2-9]| [1-9]\d)?|Merge)$/.test(label);
