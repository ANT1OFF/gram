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
  const subscribers = pending.get(key);
  if (subscribers) {
    if (callback) subscribers.add(callback);
    return null;
  }
  if (pending.size >= MAX_ENTRIES) return null;
  pending.set(key, new Set(callback ? [callback] : []));

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
    const callbacks = pending.get(key);
    pending.delete(key);
    for (const receive of callbacks ?? []) receive(tokenized);
  })();
  return null;
};
