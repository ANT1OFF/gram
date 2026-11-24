const FORBIDDEN = /[ ~^:?*[\\]/;

const hasControl = (ref: string): boolean => {
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** Whether `ref`, a full name such as `refs/heads/main`, is one git's ref grammar allows. */
export const isRefFormat = (ref: string): boolean => {
  if (ref === "" || ref === "@" || FORBIDDEN.test(ref) || hasControl(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.endsWith(".")) return false;
  return ref
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
};

/** Whether `value` would be read by git as an option where it stands as an argument. */
export const isOptionShaped = (value: string): boolean => value.startsWith("-");

/**
 * Whether `name` is a branch name git would make (`git check-ref-format --branch`). A name a
 * repository hands Gram (its branch, what `origin/HEAD` points at, a PR's base) is anyone's to
 * write who can write the folder's `.git`; it goes to git only when it passes, so git can't read
 * it as an option.
 */
export const isBranchName = (name: string): boolean =>
  name !== "HEAD" && !isOptionShaped(name) && isRefFormat(`refs/heads/${name}`);

/** Whether `name` is a remote's name git would accept (`git remote add`). */
export const isRemoteName = (name: string): boolean =>
  !isOptionShaped(name) && isRefFormat(`refs/remotes/${name}/HEAD`);

/** `origin/<branch>` when `ref` is a remote-tracking name of `origin` with a valid branch, else `undefined`. */
export const originTrackingRef = (ref: string): string | undefined =>
  ref.startsWith("origin/") && isBranchName(ref.slice("origin/".length)) ? ref : undefined;

/** ASCII alnum plus `. _ / -`, no leading `-` (git would read an option). Gates refs entering argv. */
export const isValidGitRefCharset = (raw: string): boolean =>
  raw !== "" && !isOptionShaped(raw) && /^[A-Za-z0-9._/-]+$/.test(raw);

/** The branch that may enter git argv, or `undefined` when invalid: `isBranchName` in `. _ / -` and ASCII alnum. */
export const sanitizeBranch = (raw: string): string | undefined =>
  isValidGitRefCharset(raw) && isBranchName(raw) ? raw : undefined;
