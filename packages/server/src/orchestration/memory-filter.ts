import { isMap, isScalar, parseDocument } from "yaml";

const STRONG =
  "secrets?|tokens?|keys?|apikeys?|passwords?|passwd|pwd|pw|passphrases?|cookies?|credentials?|creds?|bearer|dsn";

const WEAK = "pass|auth|authn|authz|authorization|authentication|sessions?|private|env|acl";

const WEAK_IN_TEXT = "logins?|bind";

const STEM =
  /passw(?:or)?d|passphrase|apikey|requirepass|masterauth|masteruser|credential|secret|client_send|[a-z]pwd?(?![a-z])/i;

const asWords = (alternatives: string, flags = "i") =>
  new RegExp(`(?:^|[^a-z0-9])(?:${alternatives})(?=$|[^a-z0-9])`, flags);

const STRONG_WORD = asWords(STRONG);
const WEAK_WORD = asWords(`${WEAK}|${WEAK_IN_TEXT}`, "gi");
const ANY_WORD = asWords(`${STRONG}|${WEAK}`);

const CREDENTIAL_FILE = asWords("pgpass|netrc|htpasswd|npmrc|pypirc|dockercfg|kubeconfig");

const credentialWord = (text: string): boolean =>
  ANY_WORD.test(splitCompounds(text)) || STEM.test(text);

const splitCompounds = (text: string): string =>
  splitHumps(text)
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");

const splitHumps = (text: string): string =>
  text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

const ASSIGNMENT = /=|(?<!\d):(?!\/\/)/;

const valueLike = (word: string): boolean =>
  /^["'`]/.test(word) ||
  (/[A-Za-z]/.test(word) && (/\d/.test(word) || /[A-Za-z0-9][-_@+=/:.~>][A-Za-z0-9]/.test(word)));

const LINKING = /^(?:is|was|are|be|to|as|of|set|now|=|:|-|=>)$/i;

const weakShaped = (text: string): boolean => {
  const humped = splitHumps(text);
  for (const match of humped.matchAll(WEAK_WORD)) {
    const rest = humped.slice((match.index ?? 0) + match[0].length);
    if (/^["'`]?\s*(?:=>?|:(?!\/\/))/.test(rest)) return true;
    const next = rest
      .split(/[;,\n!?]|\.(?=\s|$)/)[0]!
      .split(/\s+/)
      .filter((word) => word !== "" && !LINKING.test(word))
      .slice(0, 1)
      .map((word) => word.replace(/[).\]}]+$/, ""));
    if (next.some((word) => valueLike(word) && !/^[A-Za-z_][\w.-]*=/.test(word))) return true;
  }
  return false;
};

const directiveLine = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => {
    const bare = line
      .trim()
      .replace(PROMPT, "")
      .replace(/^[-*+>]\s+/, "");
    if (/[.!?]$/.test(bare)) return false;
    const words = bare.split(/\s+/);
    return words.length >= 2 && words.length <= 3 && credentialWord(words[0]!);
  });

const PROMPT = /^(?:[$#%]|[\w.:@[\]-]*>)\s+/;

const AUTH_COMMAND =
  /(?:^|[\s>`'"(])AUTH\s+(?!(?:is|was|are|and|or|the|to|for|with|in|on|of|by|as|via|from)\b)\S+/;

const OPTION_CREDENTIAL =
  /(?:^|\s)(?:-u|-U|--user|--username|--proxy-user)[\s=]+[^\s:]+:\S+|^(?=.*\s(?:-[uUD]|--user(?:name)?|--login)[\s=]\S).*\s-[pwaP](?:\s+|=)?\S/m;

const PAIR_LINE =
  /(?:^|\n)[ \t]*(?:\S+[ \t]+){0,2}[^\s:@/]+:[^\s:@/]*[A-Za-z][^\s:@/]*[ \t]*(?=\n|$)/;

const PAIR_VALUE = /=[^\s:=/@]+:[^\s:=/@]*[A-Za-z][^\s:=/@]*(?=\s|$)/;

const COMMAND_CREDENTIAL =
  /(?:^|\n)\s*(?:acl\s+setuser|user)\s+\S+[^\n]*?\s[>#<!]\S|\bredis-cli\b[^\n]*\s(?:-a|--user|--askpass)\b|\bmysql\b[^\n]*\s-p\S/i;

const COLON_RECORD_SHAPE = /(?:^|\s)([^\s:]+(?::[^\s:]+){3,})(?=[\s.,;)]|$)/g;

const colonRecord = (text: string): boolean =>
  [...text.matchAll(COLON_RECORD_SHAPE)].some(
    (match) => !match[1]!.split(":").every((field) => /^[0-9a-fA-F]{1,4}$/.test(field)),
  );

const credentialWords = (text: string): boolean =>
  STRONG_WORD.test(splitCompounds(text)) ||
  STEM.test(text) ||
  weakShaped(text) ||
  directiveLine(text);

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

const folded = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ßæÆøØðÐþÞ]/g, (letter) => FOLDS[letter] ?? letter);

const ENCODED = /\\[uUxX]|%[0-9a-fA-F]{2}|&#|&[A-Za-z][A-Za-z0-9]*;/;

const openDelimiter = (text: string): boolean =>
  (text.match(/-----BEGIN /g) ?? []).length !== (text.match(/-----END /g) ?? []).length ||
  (text.match(/^\s*(?:```|~~~)/gm) ?? []).length % 2 !== 0 ||
  text.split(/\r?\n/).some((line) => (line.match(/"/g) ?? []).length % 2 !== 0);

const USERINFO = /\/\/[^\s/?#]*@|[^\s:@/]+:[^\s@/]*@/;

const CONNECTION_STRING = /(?:[A-Za-z][\w ]*=[^;\n]*;\s*){2,}/;

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

const decodesToText = (token: string): boolean => {
  const bytes = base64Bytes(token);
  return bytes.length >= 4 && bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
};

const looksEncoded = (piece: string): boolean =>
  (/\d/.test(piece) && /[A-Za-z]/.test(piece)) ||
  /[a-z][A-Z]|[A-Z]{2}[a-z]/.test(piece) ||
  /.[+/=]/.test(piece);

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

const splitEncoding = (text: string): boolean =>
  joinedDecodes(text, /[^A-Za-z0-9+/=_-]+/, /^[A-Za-z0-9+/=_-]+$/, base64Bytes, 12) ||
  joinedDecodes(text, /[^A-Za-z0-9+/=]+/, /^[A-Za-z0-9+/=]+$/, base64Bytes, 12) ||
  joinedDecodes(text, /[^A-Za-z0-9]+/, /^[0-9a-fA-F]+$/, hexBytes, 10);

const hexBytes = (hex: string): Buffer =>
  Buffer.from(hex.slice(0, hex.length - (hex.length % 2)), "hex");

const LONG_RUN =
  /[A-Za-z0-9+/=_-]{20,}|[A-Za-z0-9+/_-]{4,}={1,2}(?![A-Za-z0-9])|\bbasic\s+[A-Za-z0-9+/=._-]{4,}/i;

const mixedRun = (text: string): boolean =>
  (text.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /\d/.test(run) && /[A-Za-z]/.test(run));

const TOKEN_LINE = /^[A-Za-z0-9+/=_-]+$/;

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

const tokenRun = (text: string): boolean =>
  LONG_RUN.test(text) ||
  unwrapped(text).some(
    (line) => mixedRun(line) || (line.match(BASE64_TOKEN) ?? []).some(decodesToText),
  );

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

const CITED_SHA =
  /(?<=\b(?:head|commits?|at|sha1?|rev|revision)[\s`'"(#]{1,3})(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])|(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?=…|\.\.\.)/g;

const withoutShas = (text: string): string =>
  text.replace(CITED_SHA, (sha, offset: number) => {
    const clause = clauseAround(text, offset, offset + sha.length);
    const cited =
      !ASSIGNMENT.test(clause) && !credentialWord(clause) && printableRun(hexBytes(sha)) < 8;
    return cited ? " " : sha;
  });

const TOKEN_PREFIX = /^(?:xox[a-z]|gh[pousr]|glpat|akia|asia|sk|pk|rk|hf|shpat|shpss)$/;

const DATE_DIGITS = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])?(?:0[1-9]|[12]\d|3[01])?$/;

const pronounceable = (letters: string): boolean =>
  letters.length < 12 ||
  ((letters.match(/[aeiouy]/g) ?? []).length >= letters.length / 4 &&
    !/[^aeiouy]{6,}/.test(letters));

const plainWord = (word: string): boolean => {
  const lower = word.toLowerCase();
  if (lower === "") return true;
  if (TOKEN_PREFIX.test(lower)) return false;
  const runs = lower.match(/[a-z]+|\d+/g) ?? [];
  if (runs.length > 3 || (runs.length === 3 && lower.length > 8)) return false;
  for (const run of runs) {
    if (/^\d+$/.test(run) ? run.length > 4 && !DATE_DIGITS.test(run) : !pronounceable(run)) {
      return false;
    }
  }
  return !(word.length >= 8 && decodesToText(word));
};

const tokenInName = (path: string): boolean => !path.split(/[/._-]/).every(plainWord);

const PATH = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?![A-Za-z0-9+/=_-])/g;

const withoutPaths = (text: string): string =>
  text.replace(PATH, (path) =>
    !tokenInName(path) && printableRun(base64Bytes(path.replace(/\./g, ""))) < 12 ? " " : path,
  );

const CITED_ID =
  /(?<=\b(?:threads?|workers?|workspaces?|features?|runs?|tasks?)[\s`'"(#:]{1,3})(?<![0-9A-Za-z_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z_])/g;

const withoutIds = (text: string): string =>
  text.replace(CITED_ID, (id, offset: number) =>
    credentialWord(clauseAround(text, offset, offset + id.length)) ? id : " ",
  );

const SLUG = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9+/=_-])/g;

const slugPiece = (piece: string): boolean =>
  /^\d+$/.test(piece)
    ? piece.length <= 4 || DATE_DIGITS.test(piece)
    : /^(?:[A-Za-z][a-z]*|[A-Z]+)$/.test(piece) &&
      pronounceable(piece.toLowerCase()) &&
      !TOKEN_PREFIX.test(piece.toLowerCase());

const withoutSlugs = (text: string): string =>
  text.replace(SLUG, (slug) => {
    const pieces = slug.split(/[-_]/);
    const letters = pieces.filter((piece) => /^[A-Za-z]+$/.test(piece)).join("");
    const plain =
      pieces.every(slugPiece) &&
      pieces.some((piece) => /^[A-Za-z]{2,}$/.test(piece)) &&
      pronounceable(letters.toLowerCase()) &&
      printableRun(base64Bytes(slug.replace(/[-_]/g, ""))) < 12;
    return plain ? " " : slug;
  });

type ProseProblem =
  | "characters other than plain text"
  | "escape or encoding syntax"
  | "a code fence, quote or key block left open"
  | "something shaped like a credential"
  | "something shaped like a token or encoded value";

const proseProblem = (text: string): ProseProblem | undefined => {
  if (!PLAIN_CHARS.test(text)) return "characters other than plain text";
  if (ENCODED.test(text)) return "escape or encoding syntax";
  if (openDelimiter(text)) return "a code fence, quote or key block left open";
  const ascii = folded(text);
  if (
    USERINFO.test(ascii) ||
    CONNECTION_STRING.test(ascii) ||
    colonRecord(ascii) ||
    COMMAND_CREDENTIAL.test(ascii) ||
    OPTION_CREDENTIAL.test(ascii) ||
    AUTH_COMMAND.test(ascii) ||
    PAIR_LINE.test(ascii) ||
    PAIR_VALUE.test(ascii) ||
    credentialWords(ascii)
  ) {
    return "something shaped like a credential";
  }
  const runs = withoutSlugs(withoutPaths(withoutIds(withoutShas(ascii))));
  return splitEncoding(runs) || tokenRun(runs)
    ? "something shaped like a token or encoded value"
    : undefined;
};

const lineOf = (text: string): number | undefined => {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => proseProblem(line) !== undefined);
  return at === -1 ? undefined : at + 1;
};

const PLAIN_NAME = /^(?:MEMORY\.md|[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md)$/;

const PLAIN_FOLDER = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

const nameCarries = (path: string): boolean =>
  credentialWord(path) || CREDENTIAL_FILE.test(path) || tokenInName(path);

/** Whether a worker's listing goes into the folder at `path`: plain words, no credential or token. */
export const workerMayEnter = (path: string): boolean =>
  PLAIN_FOLDER.test(path) && !nameCarries(path);

/**
 * Why a worker may not see or read a memory file. `name` and `header` are kept as they were chosen:
 * a name that carries a credential, or front matter marking the file private. `text` is a line the
 * prose checks hold back, which may be a false positive, so a worker is told of it.
 */
export interface WorkerReadProblem {
  readonly kind: "name" | "header" | "text";
  /** Names a line and a kind of problem, never the text, so it can be shown to anyone. */
  readonly reason: string;
}

/**
 * Why a worker may not see the memory file at `path`, or, given its text, read it; `undefined`
 * when it may. Its name must be plain (`PLAIN_NAME`) with no credential word or token shape in it;
 * its text plain prose (`proseProblem`) under a plain header or none (`plainHeader`).
 */
export const workerReadProblem = (path: string, text?: string): WorkerReadProblem | undefined => {
  if (!PLAIN_NAME.test(path) || nameCarries(path)) {
    return {
      kind: "name",
      reason:
        "its name isn't plain: workers see lowercase words joined by `-`, ending `.md`, with no credential word or token shape",
    };
  }
  if (text === undefined) return undefined;
  if (!plainHeader(text)) {
    return {
      kind: "header",
      reason:
        "its front matter isn't plain: it is marked private, or holds more than flat `key: value` lines",
    };
  }
  const problem = proseProblem(text);
  if (problem === undefined) return undefined;
  const line = lineOf(text);
  return {
    kind: "text",
    reason: line === undefined ? `it has ${problem}` : `line ${line} has ${problem}`,
  };
};

/**
 * Whether a worker may see the memory file at `path`, and, given its text, read it: whether
 * `workerReadProblem` finds nothing.
 */
export const workerMayRead = (path: string, text?: string): boolean =>
  workerReadProblem(path, text) === undefined;

const plainScalar = (node: unknown): boolean =>
  isScalar(node) &&
  node.tag === undefined &&
  node.anchor === undefined &&
  (node.type === "PLAIN" || node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE") &&
  (node.value === null || ["string", "number", "boolean"].includes(typeof node.value));

const plainHeader = (text: string): boolean => {
  const rest = text.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  if (rest.startsWith("<!--") || rest.startsWith("+++")) return false;
  const fence = /^---[ \t]*\r?\n/.exec(rest);
  if (fence === null) return !rest.startsWith("---");
  const body = rest.slice(fence[0].length);
  const close = /^---[ \t]*$/m.exec(body);
  if (close === null) return false;
  const header = body.slice(0, close.index);
  if (/private/i.test(header)) return false;
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
