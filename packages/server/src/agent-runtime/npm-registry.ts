/**
 * How a failed `npm view`, `npm pack` or update of the user's CLI is told to the user. Gram
 * reaches packages only through the user's own npm, so npm's exit is all there is to read;
 * its stderr can name the
 * registry, so it's classified here and never logged. Only an update the user started shows its
 * output, to them, scrubbed (`cli-update.ts`).
 */

/** The registry refused npm's credential. */
export const REGISTRY_SIGN_IN_EXPIRED = "npm registry sign-in expired: run npm login";

/** Anything else that stopped npm: a proxy, a rate limit, a missing package, the network. */
export const REGISTRY_UNREADABLE = "npm couldn't read the registry";

/**
 * Whether npm's stderr reports a 401 or 403 (pnpm's `ERR_PNPM_FETCH_403` too, for an update run
 * with pnpm). Only those are a sign-in problem, as `npm ping` judges it; a 404,
 * a 407 from a proxy or a 429 isn't.
 */
export const refusedSignIn = (stderr: string): boolean =>
  /\bE40[13]\b|\bERR_PNPM_FETCH_40[13]\b|\b40[13] (Unauthorized|Forbidden)\b/i.test(stderr);

/**
 * Whether npm refused a version for its age: a configured `min-release-age` makes
 * `npm pack <pkg>@<v>` fail with ETARGET, "No matching version found … with a date before …", for
 * a release younger than the configured age. That's the age guard doing its job, to show as waiting, not as an
 * error. `npm view` still lists such versions.
 */
export const refusedForAge = (stderr: string): boolean => /\bETARGET\b/.test(stderr);

/** The message for a non-zero npm exit with this stderr. */
export const npmFailure = (stderr: string): string =>
  refusedSignIn(stderr) ? REGISTRY_SIGN_IN_EXPIRED : REGISTRY_UNREADABLE;
