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
      .filter((word) => word !== "" && !LINKING.test(word) && !/^["'`]+$/.test(word))
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

const PLAIN_CHARS = /^[\t\n\r\x20-\x7E–—‘’“”…•·À-ÖØ-öø-ÿ→←↑↓↔⇒⇐⇔≥≤≈≠±×÷§€£✓✔✗✘✅❌]*$/;

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

const ARN_PREFIX =
  /(?<![A-Za-z0-9_-])arn:(aws(?:-cn|-us-gov|-iso(?:-[a-z])?)?):([a-z][a-z0-9-]{1,62}):((?:[a-z]{2}(?:-[a-z]+)+-\d)?):(\d{12}|aws)?:(?=[A-Za-z0-9])/g;

const withoutArnColons = (text: string): string =>
  text.replace(ARN_PREFIX, (_arn, partition: string, service: string, region: string, account) =>
    ["arn", partition, service, region, account ?? "", ""].join("~"),
  );

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
  /(?<=(?:\b(?:[Hh]ead|[Cc]ommits?|at|SHA|[Ss]ha1?|[Rr]ev|[Rr]evision|[Mm]erged as|[Ss]quashed as|[Ll]anded as|[Ff]ixed in)|#\d{1,6},?)[\s`'"(#]{1,3})(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])|(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?=…|\.\.\.)/g;

const withoutShas = (text: string): string =>
  text.replace(CITED_SHA, (sha, offset: number) => {
    const clause = clauseAround(text, offset, offset + sha.length);
    const at = clause.indexOf(sha);
    const cited =
      !ASSIGNMENT.test(clause.slice(0, at)) &&
      !clause.slice(at + sha.length).includes("=") &&
      !credentialWord(clause) &&
      printableRun(hexBytes(sha)) < 8;
    return cited ? " " : sha;
  });

const TOKEN_PREFIX = /^(?:xox[a-z]|gh[pousr]|glpat|akia|asia|sk|pk|rk|hf|shpat|shpss)$/;

const AWS_KEY_ID = /^(?:akia|asia)[a-z0-9]{16}$/;

const DATE_DIGITS = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])?(?:0[1-9]|[12]\d|3[01])?$/;

const pronounceable = (letters: string): boolean =>
  letters.length < 12 ||
  ((letters.match(/[aeiouy]/g) ?? []).length >= letters.length / 4 &&
    !/[^aeiouy]{6,}/.test(letters));

const plainWord = (word: string): boolean => {
  const lower = word.toLowerCase();
  if (lower === "") return true;
  if (TOKEN_PREFIX.test(lower) || AWS_KEY_ID.test(lower)) return false;
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
  /(?<=\b(?:[Tt]hreads?|[Ww]orkers?|[Ww]orkspaces?|[Ff]eatures?|[Rr]uns?|[Tt]asks?|[Pp]rojects?|[Rr]equests?|[Tt]races?|[Jj]obs?|[Ii]d|ID|UUID|[Uu]uid)[\s`'"(#:]{1,3})(?<![0-9A-Za-z_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9A-Za-z_])|(?<![0-9A-Za-z_])(?:i|vpc|subnet|sg|ami|vol|snap|eni|igw|nat|rtb|lt|tgw|vpce|pcx)-(?:[0-9a-f]{8}|[0-9a-f]{17})(?![0-9A-Za-z_])/g;

const withoutIds = (text: string): string =>
  text.replace(CITED_ID, (id, offset: number) =>
    credentialWord(clauseAround(text, offset, offset + id.length)) ? id : " ",
  );

const SLUG = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+(?![A-Za-z0-9+/=_-])/g;

const slugPiece = (piece: string): boolean =>
  /^\d+$/.test(piece)
    ? piece.length <= 4 || piece.length === 12 || DATE_DIGITS.test(piece)
    : /^(?:[A-Za-z][a-z]*|[A-Z]+)$/.test(piece) &&
      pronounceable(piece.toLowerCase()) &&
      !TOKEN_PREFIX.test(piece.toLowerCase()) &&
      !AWS_KEY_ID.test(piece.toLowerCase());

const NAME_VALUE =
  /(?<![A-Za-z0-9+/=_-])([A-Za-z][A-Za-z0-9_]*)=([a-z0-9]+(?:[-_.][a-z0-9]+)+)(?![A-Za-z0-9+/=_-])/g;

const plainSlugValue = (value: string): boolean => value.split(/[-_.]/).every(slugPiece);

const withoutSlugs = (text: string): string =>
  text
    .replace(NAME_VALUE, (pair, name: string, value: string) =>
      plainSlugValue(value) ? `${name} ${value}` : pair,
    )
    .replace(SLUG, (slug) => {
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
  const ascii = withoutArnColons(folded(text));
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

/** Lines a worker's view of a note leaves out, 1-based and inclusive, and why. */
export interface WithheldLines {
  readonly from: number;
  readonly to: number;
  readonly problem: string;
}

/**
 * A memory note as a worker reads it. `hidden` when the worker may not read any of it: its name or
 * header isn't plain, it hides something no part can be judged apart (characters other than plain
 * text, escape syntax, a delimiter left open), or nothing plain is left once the rest is withheld.
 * Otherwise `shown`, with every block that holds a problem replaced by one line naming the lines it
 * stood for; `withheld` lists them.
 */
export type WorkerView =
  | { readonly kind: "hidden"; readonly problem: WorkerReadProblem }
  | {
      readonly kind: "shown";
      readonly text: string;
      readonly withheld: ReadonlyArray<WithheldLines>;
    };

const BLOCK_START = /^\s*(?:[-*+]|\d{1,3}[.)])\s|^\s{0,3}#{1,6}\s/;

const HEADING = /^\s{0,3}(#{1,6})\s/;

const headingLevel = (line: string): number => HEADING.exec(line)?.[1]?.length ?? 0;

const BLOCK_PREFIX = /^\s*(?:[-*+]|\d{1,3}[.)]|#{1,6})\s+/;

const FENCE = /^\s*(?:```|~~~)/;

const KEY_BEGIN = /-----BEGIN /;

const KEY_END = /-----END /;

const BARE_TOKEN_LINE = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)?["'`]?[A-Za-z0-9+/=_-]+["'`]?[,;]?\s*$/;

interface Block {
  readonly from: number;
  readonly to: number;
}

const opensRegion = (line: string) => FENCE.test(line) || KEY_BEGIN.test(line);

const blocksOf = (lines: ReadonlyArray<string>, start: number): Array<Block> => {
  const blocks: Array<Block> = [];
  let at = start;
  while (at < lines.length) {
    const line = lines[at]!;
    if (line.trim() === "") {
      at++;
      continue;
    }
    let to = at;
    if (opensRegion(line) && !(KEY_BEGIN.test(line) && KEY_END.test(line))) {
      const closes = FENCE.test(line) ? FENCE : KEY_END;
      to = at + 1;
      while (to < lines.length - 1 && !closes.test(lines[to]!)) to++;
      to = Math.min(to, lines.length - 1);
    } else {
      while (
        to + 1 < lines.length &&
        lines[to + 1]!.trim() !== "" &&
        !BLOCK_START.test(lines[to + 1]!) &&
        !opensRegion(lines[to + 1]!)
      ) {
        to++;
      }
    }
    blocks.push({ from: at, to });
    at = to + 1;
  }
  return blocks;
};

const bodyStart = (lines: ReadonlyArray<string>): number => {
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1 || !/^\uFEFF?---[ \t]*$/.test(lines[first]!)) return 0;
  const close = lines.findIndex((line, at) => at > first && /^---[ \t]*$/.test(line));
  return close === -1 ? 0 : close + 1;
};

const leadsIntoValue = (line: string): boolean => {
  const bare = folded(line)
    .trim()
    .replace(/["'`*_)\]]+$/, "");
  if (/(?:[:=>→]|->)$/.test(bare)) return true;
  const last = bare.split(/[\s(["'`]+/).pop() ?? "";
  return LINKING.test(last) || credentialWord(last);
};

const followsValue = (line: string): boolean => {
  const bare = folded(line).replace(BLOCK_PREFIX, "").trim();
  return /^(?:[:=]|->|=>|→)/.test(bare) || LINKING.test(bare.split(/\s+/)[0] ?? "");
};

const credentialSection = (
  lines: ReadonlyArray<string>,
  blocks: ReadonlyArray<Block>,
  at: number,
) => {
  const level = (index: number) => headingLevel(lines[blocks[index]!.from]!);
  let from = at;
  let depth = level(at);
  if (depth === 0) {
    while (from > 0 && level(from - 1) === 0) from--;
    const heading = from - 1;
    if (heading >= 0) {
      depth = level(heading);
      const title = lines[blocks[heading]!.from]!.replace(HEADING, "").trim();
      if (!/\s/.test(title) && /\d|[a-z][A-Z]/.test(title)) from = heading;
    }
  }
  const inSection = (index: number) => depth === 0 || level(index) === 0 || level(index) > depth;
  let to = at;
  while (to + 1 < blocks.length && inSection(to + 1)) to++;
  return { from, to };
};

const bareTokens = (lines: ReadonlyArray<string>, block: Block | undefined): boolean =>
  block !== undefined &&
  lines.slice(block.from, block.to + 1).every((line) => BARE_TOKEN_LINE.test(line));

const spanName = (from: number, to: number): string =>
  from === to ? `line ${from}` : `lines ${from}–${to}`;

const describeWithheld = (withheld: ReadonlyArray<WithheldLines>): string =>
  withheld.map((lines) => `${spanName(lines.from, lines.to)} (${lines.problem})`).join(", ");

/**
 * The note at `path` as a worker reads it (`WorkerView`). What a worker is shown always passes the
 * same prose checks a whole note must (`workerMayRead`), markers and all; a block withheld for a
 * value takes the next block with it when it ends leading into one, the block before when it
 * starts following one, and the bare runs of token characters beside it; a block shaped like a
 * credential, whose value no check bounds, takes its whole section: for a heading, its
 * subsections too; otherwise from the heading above to the next as high, or the whole note. So no
 * piece of a value split across blocks is left showing.
 */
export const workerView = (path: string, text: string): WorkerView => {
  const problem = workerReadProblem(path, text);
  if (problem === undefined) return { kind: "shown", text, withheld: [] };
  const hidden: WorkerView = { kind: "hidden", problem };
  if (problem.kind !== "text") return hidden;
  if (!PLAIN_CHARS.test(text) || ENCODED.test(text) || openDelimiter(text)) return hidden;
  const lines = text.split(/\r?\n/);
  const body = bodyStart(lines);
  if (body > 0 && proseProblem(lines.slice(0, body).join("\n")) !== undefined) return hidden;
  const blocks = blocksOf(lines, body);
  const problems: Array<ProseProblem | undefined> = blocks.map((block) =>
    proseProblem(lines.slice(block.from, block.to + 1).join("\n")),
  );
  for (let spreading = true; spreading;) {
    spreading = false;
    blocks.forEach((block, at) => {
      const why = problems[at];
      if (why === undefined) return;
      const take = (other: number, reason: boolean) => {
        if (reason && other >= 0 && other < blocks.length && problems[other] === undefined) {
          problems[other] = why;
          spreading = true;
        }
      };
      take(at + 1, leadsIntoValue(lines[block.to]!) || bareTokens(lines, blocks[at + 1]));
      take(at - 1, followsValue(lines[block.from]!) || bareTokens(lines, blocks[at - 1]));
    });
  }
  const CREDENTIAL: ProseProblem = "something shaped like a credential";
  const named = problems.flatMap((why, index) => (why === CREDENTIAL ? [index] : []));
  for (const at of named) {
    const section = credentialSection(lines, blocks, at);
    for (let other = section.from; other <= section.to; other++) {
      problems[other] ??= CREDENTIAL;
    }
  }
  const plainLeft = blocks.some(
    (block, index) => problems[index] === undefined && headingLevel(lines[block.from]!) === 0,
  );
  if (!plainLeft) return hidden;
  const shown: Array<string> = [];
  const withheld: Array<WithheldLines> = [];
  let at = 0;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    while (at < block.from) shown.push(lines[at++]!);
    const why = problems[index];
    if (why === undefined) {
      while (at <= block.to) shown.push(lines[at++]!);
      continue;
    }
    let last = index;
    while (last + 1 < blocks.length && problems[last + 1] !== undefined) last++;
    const end = blocks[last]!.to;
    const kinds = new Set(problems.slice(index, last + 1));
    const kind = kinds.has(CREDENTIAL) ? CREDENTIAL : why;
    const prefix = BLOCK_PREFIX.exec(lines[block.from]!)?.[0] ?? "";
    shown.push(`${prefix}[${spanName(block.from + 1, end + 1)} withheld from workers]`);
    withheld.push({ from: block.from + 1, to: end + 1, problem: kind });
    at = end + 1;
    index = last;
  }
  while (at < lines.length) shown.push(lines[at++]!);
  const view = shown.join("\n");
  return proseProblem(view) === undefined ? { kind: "shown", text: view, withheld } : hidden;
};

/**
 * What a worker sees of the note at `path`, given its text: the text it is `shown`, if any; why it
 * reads none or only part of it (`withheld`, by line and kind of problem, never the text), which
 * `memory_list` names; and `note`, the same as a sentence for the memory editor.
 */
export interface WorkerSight {
  readonly shown?: string;
  readonly withheld?: string;
  readonly note?: string;
}

/** `workerView` of a note, as `memory_list`, `memory_read` and the memory editor tell it. */
export const workerSees = (path: string, text: string): WorkerSight => {
  const view = workerView(path, text);
  if (view.kind === "hidden") {
    const { kind, reason } = view.problem;
    const note = `Workers can't read this file: ${reason}`;
    return kind === "text" ? { withheld: reason, note } : { note };
  }
  if (view.withheld.length === 0) return { shown: view.text };
  const lines = describeWithheld(view.withheld);
  const note = `Workers read this file without ${lines}`;
  return { shown: view.text, withheld: `read without ${lines}`, note };
};

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
      isScalar(pair.key) &&
      typeof pair.key.value === "string" &&
      pair.key.value !== "<<" &&
      (pair.value === null || plainScalar(pair.value)),
  );
};
