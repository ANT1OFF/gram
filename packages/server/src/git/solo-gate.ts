// What a solo merge with its local gate off is told when CI can't let it through.
import { type PrStatus, requiredChecksOf } from "@gram/contracts";

/**
 * Why a solo merge whose local gate is off (`localGate`, "no local check configured for …") can't go
 * through as things stand: with no local check, the gate needs green CI on the head, and the head
 * has reported no CI checks or failing ones. Said when the merge is armed, so an agent isn't left
 * waiting on CI that never runs. The gate itself is unchanged; `undefined` when CI may yet pass.
 * `standIn`, when the gate is off for where the thread is, says what stands in for absent CI there.
 */
export const soloGateCantPass = (
  badge: PrStatus,
  localGate: string,
  standIn?: string,
): string | undefined => {
  if (badge.state !== "OPEN" || badge.headRefOid === undefined) return undefined;
  const checks = requiredChecksOf(badge);
  const failing = checks === "failing" || badge.mergeChecks === "failing";
  if (checks !== "none" && !failing) return undefined;
  const head = badge.headRefOid.slice(0, 7);
  const configure =
    "the user configures a local check for the project (`project.localCheck.command`, with an optional `project.localCheck.setup`), proposed by the orchestrator or a plain thread through settings_propose and approved by the user";
  if (standIn !== undefined)
    return failing
      ? `This merge can't go through yet: ${localGate}, so the solo gate needs green CI on its head, and CI on ${head} is failing. Gram merges it only once CI passes on its head: re-run it or push a fix.`
      : `This merge can't go through as things stand: ${localGate}, so the solo gate needs green CI on its head, and ${head} has reported no CI checks. If CI never runs for this repository or branch, tell your orchestrator: ${standIn}.`;
  return failing
    ? `This merge can't go through yet: ${localGate}, so the solo gate needs green CI on its head, and CI on ${head} is failing. Gram merges it only once CI passes on its head: re-run it or push a fix. If CI fails because it can't run in this repository (Actions disabled, out of minutes or billing), fix that on GitHub; a local check stands in for pending or absent CI once ${configure}, but never for failing CI.`
    : `This merge can't go through as things stand: ${localGate}, so the solo gate needs green CI on its head, and ${head} has reported no CI checks. If CI never runs for this repository or branch, it never will: tell your orchestrator, so ${configure}. Gram's check of the head then stands in for the missing CI.`;
};
