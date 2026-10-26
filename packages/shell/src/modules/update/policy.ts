export interface AutoCheckInputs {
  readonly packaged: boolean;
  /** A `--smoke` run. */
  readonly smoke: boolean;
  /** A releases repo is configured; without one there's nothing to check. */
  readonly repoConfigured: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Whether windows may check for updates on their own: packaged builds outside CI, never in a smoke
 * run or without a releases repo. `GRAM_UPDATE_CHECK=1` or `=0` overrides the packaged and
 * CI tests.
 */
export function autoUpdateCheckEnabled({
  packaged,
  smoke,
  repoConfigured,
  env,
}: AutoCheckInputs): boolean {
  if (smoke || !repoConfigured) return false;
  const override = env["GRAM_UPDATE_CHECK"];
  if (override === "0") return false;
  if (override === "1") return true;
  return packaged && !env["CI"];
}
