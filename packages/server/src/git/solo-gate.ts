import { type PrStatus, requiredChecksOf } from "@gram/contracts";

/**
 * Why a solo merge whose local gate is off (`localGate`, "no local check configured for …") can't go
 * through as things stand: with no local check, the gate needs green CI on the head, and the head
 * has reported no CI checks or failing ones. Said when the merge is armed, so an agent isn't left
 * waiting on CI that never runs. The gate itself is unchanged; `undefined` when CI may yet pass.
 * `declaredCiOnly`: the thread is on a provisioned machine, where only the base's declared CI counts:
 * there, no checks on the head is no verdict, so the warning says what the merge waits for instead.
 */
export const soloGateCantPass = (
  badge: PrStatus,
  localGate: string,
  declaredCiOnly?: boolean,
): string | undefined => {
  if (badge.state !== "OPEN" || badge.headRefOid === undefined) return undefined;
  const checks = requiredChecksOf(badge);
  const failing = checks === "failing" || badge.mergeChecks === "failing";
  if (checks !== "none" && !failing) return undefined;
  const head = badge.headRefOid.slice(0, 7);
  const configure =
    "the user configures a local check for the project (`project.localCheck.command`, with an optional `project.localCheck.setup`), proposed by the orchestrator or a plain thread through settings_propose and approved by the user";
  if (declaredCiOnly === true)
    return failing
      ? `This merge can't go through yet: ${localGate}, and CI on ${head} is failing. Gram merges it only once the declared CI passes on its head: re-run it or push a fix.`
      : `This merge waits for the CI its base branch declares: ${localGate}. GitHub has reported no CI checks on ${head} yet, and they don't decide it here: Gram merges it once every job declared in the base branch's \`.gram/merge-ci.json\` passes on ${head}. If the base branch declares no CI there, the merge is refused: tell your orchestrator, so a worker on one of the user's own machines can take the PR over, where Gram's own check of the head stands in.`;
  return failing
    ? `This merge can't go through yet: ${localGate}, so the solo gate needs green CI on its head, and CI on ${head} is failing. Gram merges it only once CI passes on its head: re-run it or push a fix. If CI fails because it can't run in this repository (Actions disabled, out of minutes or billing), fix that on GitHub; a local check stands in for pending or absent CI once ${configure}, but never for failing CI.`
    : `This merge can't go through as things stand: ${localGate}, so the solo gate needs green CI on its head, and ${head} has reported no CI checks. If CI never runs for this repository or branch, it never will: tell your orchestrator, so ${configure}. Gram's check of the head then stands in for the missing CI.`;
};
