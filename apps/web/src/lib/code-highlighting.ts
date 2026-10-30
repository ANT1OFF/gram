import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

// Bound grammar work and retained transcript text. Large content remains selectable plain text.
const MAX_CODE_LENGTH = 16_384;
const MAX_LINE_LENGTH = 2_048;
const MAX_LINES = 500;
const MAX_ENTRIES = 64;

/** Shared bound for classification and grammar work on untrusted tool text. */
export const canHighlightCode = (code: string): boolean => {
  if (code.length > MAX_CODE_LENGTH) return false;
  const lines = code.split("\n");
  return lines.length <= MAX_LINES && lines.every((line) => line.length <= MAX_LINE_LENGTH);
};

const highlighters = new Map<
  BundledLanguage,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();
const tokensCache = new Map<string, TokenizedCode>();
const pending = new Map<string, Set<(result: TokenizedCode) => void>>();
/**
 * What asked while `MAX_ENTRIES` were already being worked on, oldest first, started as they
 * finish: a long diff's later hunks get their colours too. Bounded, dropping the oldest, which stay
 * plain text.
 */
const waiting = new Map<
  string,
  { code: string; language: BundledLanguage; callbacks: Set<(result: TokenizedCode) => void> }
>();
const MAX_WAITING = 256;

export const createRawTokens = (code: string): TokenizedCode => {
  let offset = 0;
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code.split("\n").map((line) => {
      const token = { color: "inherit", content: line, offset };
      offset += line.length + 1;
      return line === "" ? [] : [token];
    }),
  };
};

const getHighlighter = (language: BundledLanguage) => {
  const cached = highlighters.get(language);
  if (cached) return cached;
  const promise = import("shiki")
    .then(({ createHighlighter }) =>
      createHighlighter({ langs: [language], themes: ["github-light", "github-dark"] }),
    )
    .catch((error: unknown) => {
      highlighters.delete(language);
      throw error;
    });
  highlighters.set(language, promise);
  return promise;
};

/** Synchronous cache lookup with one background tokenization per exact source/language. */
export const highlightCode = (
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!canHighlightCode(code)) return null;
  // A prefix/suffix key can substitute different text with the same length and ends.
  const key = `${language}:${code}`;
  const cached = tokensCache.get(key);
  if (cached) {
    tokensCache.delete(key);
    tokensCache.set(key, cached);
    return cached;
  }
  const subscribers = pending.get(key) ?? waiting.get(key)?.callbacks;
  if (subscribers) {
    if (callback) subscribers.add(callback);
    return null;
  }
  if (pending.size >= MAX_ENTRIES) {
    waiting.set(key, { code, language, callbacks: new Set(callback ? [callback] : []) });
    if (waiting.size > MAX_WAITING) waiting.delete(waiting.keys().next().value!);
    return null;
  }
  tokenize(key, code, language, new Set(callback ? [callback] : []));
  return null;
};

/** One background tokenization, then the oldest waiting one in its place. */
const tokenize = (
  key: string,
  code: string,
  language: BundledLanguage,
  callbacks: Set<(result: TokenizedCode) => void>,
) => {
  pending.set(key, callbacks);

  // The existing Shiki engine/themes are retained; failures resolve to the original source.
  void (async () => {
    let tokenized: TokenizedCode;
    try {
      const highlighter = await getHighlighter(language);
      const result = highlighter.codeToTokens(code, {
        lang: language,
        themes: { dark: "github-dark", light: "github-light" },
      });
      tokenized = {
        bg: result.bg ?? "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };
    } catch {
      tokenized = createRawTokens(code);
    }
    tokensCache.set(key, tokenized);
    if (tokensCache.size > MAX_ENTRIES) tokensCache.delete(tokensCache.keys().next().value!);
    // The set callers joined while it ran, which `pending` handed them.
    pending.delete(key);
    for (const receive of callbacks) receive(tokenized);
    const next = waiting.entries().next().value;
    if (next !== undefined) {
      const [nextKey, queued] = next;
      waiting.delete(nextKey);
      tokenize(nextKey, queued.code, queued.language, queued.callbacks);
    }
  })();
};
