/**
 * What of the orchestrator's memory a worker may see: an allow-list that fails closed.
 *
 * A worker lists and reads a memory file only when its name is plain and carries no credential or
 * token shape, and its text is plainly safe prose under a plain header or none. Anything else is
 * dropped whole, never redacted or partly shown; the orchestrator sees it all. The checks look at
 * structure (assignments, userinfo, encodings, token shapes) as well as words, so a credential that
 * avoids one keyword still meets the shape it has to take.
 */
import { isMap, isScalar, parseDocument } from "yaml";

// Words ---------------------------------------------------------------------------------------

/** Credential words that drop an entry wherever they appear. */
const STRONG =
  "secrets?|tokens?|keys?|apikeys?|passwords?|passwd|pwd|pw|passphrases?|cookies?|credentials?|creds?|bearer|dsn";

/**
 * Words that are credential labels only in a credential's shape, and ordinary words in prose
 * ("keeps authentication in the CLI", "the tests pass"): they drop an entry when a value follows
 * them (`weakShaped`), or when they lead a bare directive line (`directiveLine`).
 */
const WEAK = "pass|auth|authn|authz|authorization|authentication|sessions?|private|env|acl";

/**
 * Credential stems that drop an entry inside any word, compounds that don't split included:
 * `PGPASSWORD`, `requirepass`, `masterauth`, `MYAPIKEY`.
 */
const STEM = /passw(?:or)?d|passphrase|apikey|requirepass|masterauth|masteruser|credential|secret/i;

/** `alternatives` as whole words: anything but a letter or digit is a boundary (`_`, `-`, `.`). */
const asWords = (alternatives: string, flags = "i") =>
  new RegExp(`(?:^|[^a-z0-9])(?:${alternatives})(?=$|[^a-z0-9])`, flags);

const STRONG_WORD = asWords(STRONG);
const WEAK_WORD = asWords(WEAK, "gi");
const ANY_WORD = asWords(`${STRONG}|${WEAK}`);

/** Names of files that hold credentials, as a word in a memory name: `pgpass.md`, `netrc.md`. */
const CREDENTIAL_FILE = asWords("pgpass|netrc|htpasswd|npmrc|pypirc|dockercfg|kubeconfig");

/** Whether `text` has a credential word or stem: what a name, or any clause, may not carry. */
const credentialWord = (text: string): boolean =>
  ANY_WORD.test(splitCompounds(text)) || STEM.test(text);

/**
 * `text` with its compound words split: camelCase and PascalCase humps (`accessKey`, `APIKey`), and
 * letters from digits (`key2`), so a credential word inside a compound is a word of its own.
 * `snake_case` and `kebab-case` already split, `_` and `-` being boundaries.
 */
const splitCompounds = (text: string): string =>
  splitHumps(text)
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");

/** `text` with camelCase and PascalCase humps split, and nothing else. */
const splitHumps = (text: string): string =>
  text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

/** An assignment's shape: `=`, `=>`, or a `:` after a key (not a date's or a time's, not `://`). */
const ASSIGNMENT = /=|(?<!\d):(?!\/\/)/;

/** A word that looks like a value: letters with digits, letters joined by punctuation, or quoted. */
const valueLike = (word: string): boolean =>
  /^["'`]/.test(word) ||
  (/[A-Za-z]/.test(word) && (/\d/.test(word) || /[A-Za-z0-9][-_@+=/:.~>][A-Za-z0-9]/.test(word)));

/** Words a value may follow a label through: `the session is orchard-willow`. */
const LINKING = /^(?:is|was|are|be|to|as|of|set|now|=|:|-|=>)$/i;

/**
 * Whether a weak credential word is followed by a value: an assignment right after it
 * (`auth: x`, `session=x`), or a value-like word among the next two (`session orchard-willow`,
 * `env is staging-2`), linking words skipped. A value elsewhere in the clause (`retry=false`, a path,
 * `owner/repo#198`) is not the weak word's.
 */
const weakShaped = (text: string): boolean => {
  const humped = splitHumps(text);
  for (const match of humped.matchAll(WEAK_WORD)) {
    const rest = humped.slice((match.index ?? 0) + match[0].length);
    if (/^["'`]?\s*(?:=>?|:(?!\/\/))/.test(rest)) return true;
    const next = rest
      .split(/[;,\n!?]|\.(?=\s|$)/)[0]!
      .split(/\s+/)
      .filter((word) => word !== "" && !LINKING.test(word))
      .slice(0, 2)
      .map((word) => word.replace(/[).\]}]+$/, ""));
    if (next.some(valueLike)) return true;
  }
  return false;
};

/**
 * A bare directive line: a credential word (or stem) followed by one or two bare words and nothing
 * else, as config files and commands write them (`AUTH orchard`, `AUTH amy orchard`,
 * `requirepass orchard`, `pass orchard`).
 */
const directiveLine = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => {
    const words = line
      .trim()
      .replace(/^[-*+>]\s+/, "")
      .split(/\s+/);
    return words.length >= 2 && words.length <= 3 && credentialWord(words[0]!);
  });

/**
 * A Redis ACL rule or a password on a client's command line: `user amy on >orchard ~* +@all`,
 * `ACL SETUSER amy >orchard`, `redis-cli -a orchard`, `mysql -porchard`.
 */
const COMMAND_CREDENTIAL =
  /(?:^|\n)\s*(?:acl\s+setuser|user)\s+\S+[^\n]*?\s[>#<!]\S|\bredis-cli\b[^\n]*\s(?:-a|--user|--askpass)\b|\bmysql\b[^\n]*\s-p\S/i;

/**
 * A positional credential record: four or more `:`-separated fields with no spaces, as a password
 * file holds them (`.pgpass`'s `host:port:db:user:password`, and the like).
 */
const COLON_RECORD = /(?:^|\s)[^\s:]*(?::[^\s:]*){3,}(?=\s|$)/;

/** Whether `text` has a credential word: a strong one or a stem anywhere, a weak one with a value. */
const credentialWords = (text: string): boolean =>
  STRONG_WORD.test(splitCompounds(text)) ||
  STEM.test(text) ||
  weakShaped(text) ||
  directiveLine(text);

// Characters ----------------------------------------------------------------------------------

/**
 * Characters plain prose is made of: printable ASCII, tab and newlines, common typographic
 * punctuation, and the precomposed Latin-1 letters (`é`, `ü`, `ß`), which fold to ASCII before any
 * check. No other Unicode: no lookalike, combining mark or zero-width character.
 */
const PLAIN_CHARS = /^[\t\n\r\x20-\x7E–—‘’“”…•·À-ÖØ-öø-ÿ]*$/;

const FOLDS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  ø: "o",
  Ø: "O",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "Th",
};

/** `text` with its Latin-1 letters folded to ASCII (`pässwörd` reads `password`). */
const folded = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ßæÆøØðÐþÞ]/g, (letter) => FOLDS[letter] ?? letter);

/** Escape or encoding syntax of any kind: `\u`, `\x`, `%XX`, `&#`, `&name;`. */
const ENCODED = /\\[uUxX]|%[0-9a-fA-F]{2}|&#|&[A-Za-z][A-Za-z0-9]*;/;

/** A delimiter left open that something could hide behind: a PEM block, a code fence, a quote. */
const openDelimiter = (text: string): boolean =>
  (text.match(/-----BEGIN /g) ?? []).length !== (text.match(/-----END /g) ?? []).length ||
  (text.match(/^\s*(?:```|~~~)/gm) ?? []).length % 2 !== 0 ||
  text.split(/\r?\n/).some((line) => (line.match(/"/g) ?? []).length % 2 !== 0);

// Structure -----------------------------------------------------------------------------------

/**
 * Userinfo in a URL or network path: `//…@` (with or without a scheme), or `user:pass@` anywhere.
 */
const USERINFO = /\/\/[^\s/?#]*@|[^\s:@/]+:[^\s@/]*@/;

/** A connection string's shape: two or more `Key=value;` fields in a row (ODBC, ADO, JDBC). */
const CONNECTION_STRING = /(?:[A-Za-z][\w ]*=[^;\n]*;\s*){2,}/;

// Encodings -----------------------------------------------------------------------------------

/** The longest run of printable ASCII in `bytes`. */
const printableRun = (bytes: Iterable<number>): number => {
  let best = 0;
  let run = 0;
  for (const byte of bytes) {
    run = byte >= 0x20 && byte <= 0x7e ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
};

const base64Bytes = (token: string): Buffer =>
  Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Whether a base64 or base64url token decodes wholly to printable text (4 bytes or more). */
const decodesToText = (token: string): boolean => {
  const bytes = base64Bytes(token);
  return bytes.length >= 4 && bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
};

/** A piece that looks encoded rather than a word: letters with digits, inner capitals, `+/=`. */
const looksEncoded = (piece: string): boolean =>
  (/\d/.test(piece) && /[A-Za-z]/.test(piece)) ||
  /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(piece) ||
  /.[+/=]/.test(piece);

/**
 * Whether pieces of `text`, split at `separator` (spaces, lines, commas, quotes, list markers, any
 * punctuation) and joined back from some piece on, decode to `span` or more printable characters:
 * an encoding split up however it is. A join counts up to its farthest piece where a third or more
 * of its pieces look encoded, so plain words joined together are not taken for one.
 */
const joinedDecodes = (
  text: string,
  separator: RegExp,
  piece: RegExp,
  decode: (joined: string) => Iterable<number>,
  span: number,
): boolean => {
  const pieces = text.split(separator).filter((each) => each !== "");
  for (let start = 0; start < pieces.length; start++) {
    let encoded = 0;
    let reach = -1;
    for (let end = start; end < pieces.length && end < start + 64; end++) {
      if (!piece.test(pieces[end]!)) break;
      if (looksEncoded(pieces[end]!)) encoded++;
      if (encoded * 3 >= end - start + 1) reach = end;
    }
    if (reach < 0) continue;
    const joined = pieces.slice(start, reach + 1).join("");
    if (joined.length >= span + span / 3 && printableRun(decode(joined)) >= span) return true;
  }
  return false;
};

/**
 * Whether `text` holds base64 or hex, whole or split by punctuation or whitespace at any width,
 * that decodes to text: base64url and standard base64 (where `-` and `_` may be separators), and hex
 * bytes (`67:68:70`, `67 68 70`).
 */
const splitEncoding = (text: string): boolean =>
  joinedDecodes(text, /[^A-Za-z0-9+/=_-]+/, /^[A-Za-z0-9+/=_-]+$/, base64Bytes, 12) ||
  joinedDecodes(text, /[^A-Za-z0-9+/=]+/, /^[A-Za-z0-9+/=]+$/, base64Bytes, 12) ||
  joinedDecodes(text, /[^A-Za-z0-9]+/, /^[0-9a-fA-F]+$/, hexBytes, 10);

const hexBytes = (hex: string): Buffer =>
  Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), "hex");

/**
 * A token-like run: 20 or more base64, base64url or hex characters; a short one padded as base64
 * (`dG9rZW4=`); or a `Basic` scheme followed by a token of any length.
 */
const LONG_RUN =
  /[A-Za-z0-9+/=_-]{20,}|[A-Za-z0-9+/_-]{4,}={1,2}(?![A-Za-z0-9])|\bbasic\s+[A-Za-z0-9+/=._-]{4,}/i;

/** Whether `text` has a run of 16 or more letters and digits that mixes the two. */
const mixedRun = (text: string): boolean =>
  (text.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));

const TOKEN_LINE = /^[A-Za-z0-9+/=_-]+$/;

/** The text's lines, with each run of token-only lines (a wrapped token) joined into one. */
const unwrapped = (text: string): Array<string> => {
  const lines: Array<string> = [];
  let run = "";
  for (const line of text.split(/\r?\n/).map((item) => item.trim())) {
    if (TOKEN_LINE.test(line)) {
      run += line;
      continue;
    }
    if (run !== "") lines.push(run);
    run = "";
    lines.push(line);
  }
  if (run !== "") lines.push(run);
  return lines;
};

const BASE64_TOKEN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;

/** Whether `text` has a token run, wrapped over lines or not. */
const tokenRun = (text: string): boolean =>
  LONG_RUN.test(text) ||
  unwrapped(text).some(
    (line) => mixedRun(line) || (line.match(BASE64_TOKEN) ?? []).some(decodesToText),
  );

// Words that are not tokens: cited SHAs, plain paths, plain names --------------------------------

/** The clause of `text` around `[start, end)`, between the separators `clauses` splits at. */
const clauseAround = (text: string, start: number, end: number): string => {
  const boundary = (at: number) =>
    /[;,\n!?]/.test(text[at]!) ||
    (text[at] === "." && (at + 1 >= text.length || /\s/.test(text[at + 1]!)));
  let from = start;
  while (from > 0 && !boundary(from - 1)) from--;
  let to = end;
  while (to < text.length && !boundary(to)) to++;
  return text.slice(from, to);
};

/**
 * A commit SHA as prose cites it: a pure run of 7 to 40 lowercase hex characters, after `head`,
 * `commit`, `at`, `sha` or `rev`, or followed by an ellipsis (`abc1234…`).
 */
const CITED_SHA =
  /(?<=\b(?:head|commits?|at|sha1?|rev|revision)[\s`'"(#]{1,3})(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])|(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?=…|\.\.\.)/g;

/**
 * `text` with each cited SHA taken out, so a dated decision can name its commit. A SHA is taken out
 * only when its clause has no assignment and no credential word, and its hex doesn't decode to 8 or
 * more printable characters; otherwise it stays in and is checked like any other run.
 */
const withoutShas = (text: string): string =>
  text.replace(CITED_SHA, (sha, offset: number) => {
    const clause = clauseAround(text, offset, offset + sha.length);
    const cited =
      !ASSIGNMENT.test(clause) && !credentialWord(clause) && printableRun(hexBytes(sha)) < 8;
    return cited ? " " : sha;
  });

/** The first word of a known token shape: Slack `xoxb-`, GitHub `ghp_`, GitLab `glpat-`, AWS `akia`. */
const TOKEN_PREFIX = /^(?:xox[a-z]|gh[pousr]|glpat|akia|asia|sk|pk|rk|hf|shpat|shpss)$/;

/** A date's digits (`2026`, `202611`, `20261107`): digits that are no token. */
const DATE_DIGITS = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])?(?:0[1-9]|[12]\d|3[01])?$/;

/**
 * Whether a run of letters reads as a word rather than random letters: at least a quarter vowels,
 * and no more than five consonants in a row. Short runs always do.
 */
const pronounceable = (letters: string): boolean =>
  letters.length < 12 ||
  ((letters.match(/[aeiouy]/g) ?? []).length >= letters.length / 4 &&
    !/[^aeiouy]{6,}/.test(letters));

/**
 * Whether one word of a name or path is plain, not a token: not a known token prefix; digits only
 * when four or fewer or a date; at most one switch between letters and digits (`test2026`, `v2`,
 * `2fa`), or two in a short word (`e2e`, `16x16`), not `a1b2c3`; letters that read as a word; and no base64 that decodes to text.
 */
const plainWord = (word: string): boolean => {
  const lower = word.toLowerCase();
  if (lower === "") return true;
  if (TOKEN_PREFIX.test(lower)) return false;
  const runs = lower.match(/[a-z]+|\d+/g) ?? [];
  // Short alternations name things (`e2e`, `16x16`, `utf8proc`); longer ones are token-shaped.
  if (runs.length > 3 || (runs.length === 3 && lower.length > 8)) return false;
  for (const run of runs) {
    if (/^\d+$/.test(run) ? run.length > 4 && !DATE_DIGITS.test(run) : !pronounceable(run)) {
      return false;
    }
  }
  return !(word.length >= 8 && decodesToText(word));
};

/** Whether a name or path carries a token in its words (split at `/`, `-`, `_` and `.`). */
const tokenInName = (path: string): boolean => !path.split(/[/._-]/).every(plainWord);

/** A path in prose: two or more segments joined by `/`, each letters, digits, `-`, `_` or `.`. */
const PATH = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?![A-Za-z0-9+/=_-])/g;

/**
 * `text` with each plain path taken out (`packages/server/src/orchestration/service/spawning.ts`),
 * so a source location isn't a token run. A path is taken out only when every word in it is plain
 * and it doesn't decode as base64 to 12 or more printable characters.
 */
const withoutPaths = (text: string): string =>
  text.replace(PATH, (path) =>
    !tokenInName(path) && printableRun(base64Bytes(path.replace(/\./g, ""))) < 12 ? " " : path,
  );

// Decisions -----------------------------------------------------------------------------------

/**
 * Whether an entry is plainly safe prose a worker may read. Every character is plain (ASCII,
 * typographic punctuation, Latin-1 letters folded to ASCII); there is no escape or encoding syntax,
 * delimiter left open, URL userinfo or connection string; no strong credential word anywhere, nor a
 * weak one in a value's shape (camelCase and snake_case split first); no base64 or hex that decodes
 * to text, however it is split; and no token-like run once cited SHAs and plain paths are taken out.
 */
const plainProse = (text: string): boolean => {
  if (openDelimiter(text) || !PLAIN_CHARS.test(text) || ENCODED.test(text)) return false;
  const ascii = folded(text);
  if (USERINFO.test(ascii) || CONNECTION_STRING.test(ascii) || COLON_RECORD.test(ascii))
    return false;
  if (COMMAND_CREDENTIAL.test(ascii) || credentialWords(ascii)) return false;
  const runs = withoutPaths(withoutShas(ascii));
  return !splitEncoding(runs) && !tokenRun(runs);
};

/** What a worker's `memory_list` shows: lowercase words joined by `-`, in folders, ending `.md`. */
const PLAIN_NAME = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/;

/** A folder a worker's `memory_list` goes into: lowercase words joined by `-`, nested. */
const PLAIN_FOLDER = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

/** Whether a name carries a credential word or stem, a credential file's name, or a token. */
const nameCarries = (path: string): boolean =>
  credentialWord(path) || CREDENTIAL_FILE.test(path) || tokenInName(path);

/** Whether a worker's listing goes into the folder at `path`: plain words, no credential or token. */
export const workerMayEnter = (path: string): boolean =>
  PLAIN_FOLDER.test(path) && !nameCarries(path);

/**
 * Whether a worker may see the memory file at `path`, and, given its text, read it. Its name must be
 * plain (`PLAIN_NAME`) with no credential word or token shape in it; its text plain prose
 * (`plainProse`) under a plain header or none (`plainHeader`). A file it may not see is neither
 * listed nor read.
 */
export const workerMayRead = (path: string, text?: string): boolean => {
  if (!PLAIN_NAME.test(path) || nameCarries(path)) return false;
  if (text === undefined) return true;
  return plainHeader(text) && plainProse(text);
};

// Headers -------------------------------------------------------------------------------------

/** A YAML node that is a plain or quoted scalar with no tag or anchor: what a plain header holds. */
const plainScalar = (node: unknown): boolean =>
  isScalar(node) &&
  node.tag === undefined &&
  node.anchor === undefined &&
  (node.type === "PLAIN" || node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE") &&
  (node.value === null || ["string", "number", "boolean"].includes(typeof node.value));

/**
 * Whether a worker may read a file's text, by its header, failing closed. Allowed only when the file
 * has no header at all (its first non-blank text is the body), or its header is one closed `---`
 * YAML front matter block that parses cleanly as a flat block map whose keys and values are plain
 * or quoted scalars: no tags (`!!omap`, `!!set`, …), anchors, aliases, merge keys, nesting, flow
 * style or block scalars, and the word `private` nowhere in the header, comments included.
 * Everything else (an HTML comment before the body, TOML, an unclosed block, YAML that doesn't
 * parse or holds anything more) is private to workers. The orchestrator reads it all.
 */
const plainHeader = (text: string): boolean => {
  const rest = text.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  // A leading HTML comment, a TOML block, or anything fence-like that isn't `---`: not plain.
  if (rest.startsWith("<!--") || rest.startsWith("+++")) return false;
  const fence = /^---[ \t]*\r?\n/.exec(rest);
  if (fence === null) return !rest.startsWith("---");
  const body = rest.slice(fence[0].length);
  // Only `---` closes it: a `...` end-of-document line is no close, and fails the line check below.
  const close = /^---[ \t]*$/m.exec(body);
  if (close === null) return false;
  const header = body.slice(0, close.index);
  if (/private/i.test(header)) return false;
  // Line by line too, so syntax that parses to a flat map anyway (an explicit `? key`, a directive,
  // a value carried onto the next line) is refused: each line is blank, a comment, or one
  // unindented `key: value` with a plain key.
  const lines = header.split(/\r?\n/);
  if (
    !lines.every(
      (line) =>
        line.trim() === "" || line.startsWith("#") || /^[A-Za-z_][\w.-]*:(?:[ \t]|$)/.test(line),
    )
  ) {
    return false;
  }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(header, { uniqueKeys: true, merge: false });
  } catch {
    return false;
  }
  if (doc.errors.length > 0 || doc.warnings.length > 0) return false;
  const contents = doc.contents;
  // An empty front matter block is as good as none.
  if (contents === null) return true;
  if (!isMap(contents) || contents.flow === true || contents.tag !== undefined) return false;
  if (contents.anchor !== undefined) return false;

  return contents.items.every(
    (pair) =>
      plainScalar(pair.key) &&
      typeof (pair.key as { value: unknown }).value === "string" &&
      (pair.key as { value: string }).value !== "<<" &&
      (pair.value === null || plainScalar(pair.value)),
  );
};
