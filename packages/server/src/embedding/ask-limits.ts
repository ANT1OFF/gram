// The most of a question ask `ask.opened` carries (`event-sink.ts`); past any of these it carries
// none of it, since an answer is keyed by each question's text and names choices by their labels.

export const ASK_QUESTIONS_MAX = 8;
export const ASK_QUESTION_MAX_CHARS = 4000;
export const ASK_OPTIONS_MAX = 20;
export const ASK_OPTION_LABEL_MAX_CHARS = 200;
/** A choice's description is cut to this, which an answer never names. */
export const ASK_OPTION_DESCRIPTION_MAX_CHARS = 2000;
