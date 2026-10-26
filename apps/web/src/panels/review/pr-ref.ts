/** A pull request the user typed; `repo` (`owner/repo`) is absent for a bare number. */
export interface PrRef {
  readonly repo?: string;
  readonly number: number;
}

const BARE = /^#?(\d+)$/;
const SHORT = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const URL_REF =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:\/[\w-]*)?\/?(?:[?#].*)?$/i;

const toRef = (repo: string | undefined, digits: string): PrRef | undefined => {
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return repo === undefined ? { number } : { repo, number };
};

/**
 * Parses `12`, `#12`, `owner/repo#12` or a github.com PR URL (a trailing slash, `/files` and the
 * like are fine); `undefined` for anything else.
 */
export function parsePrRef(input: string): PrRef | undefined {
  const text = input.trim();
  const bare = BARE.exec(text);
  if (bare) return toRef(undefined, bare[1]!);
  const short = SHORT.exec(text) ?? URL_REF.exec(text);
  return short ? toRef(short[1], short[2]!) : undefined;
}
