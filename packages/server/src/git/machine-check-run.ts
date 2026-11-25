import {
  DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
  hostServes,
  type HostCheckResult,
  type InspectedWorktreeHook,
} from "@gram/contracts";
import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { HostCheckRequest } from "../host/checks.ts";
import { WORKTREE_HOOK_VERSION } from "../host/worktree-hook-source.ts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import type { MachineCheckSite } from "./check-site.ts";
import type { LocalCheckFailure, LocalCheckOutcome, LocalCheckRun } from "./check-process.ts";
import type { LocalCheck } from "./local-checks.ts";
import { withHostCheckDiagnostic } from "./local-check-files.ts";
import type { WorktreeHookGrant } from "../runtime/worktree-hook-consent.ts";

const SHA = /^[a-f0-9]{40}$/;
const MACHINE_POLL_MS = 2_000;
const MACHINE_SLACK_MS = 10 * 60_000;

export const machineCheckFailure = (
  name: string,
  reason: string,
  kind: LocalCheckFailure["kind"],
): HostCheckResult & LocalCheckOutcome => ({
  tree: null,
  ok: false,
  reason,
  failure: { kind },
  host: name,
});

export const runMachineCheck = ({
  site,
  started,
  wanted,
  name,
  remoteHosts,
  reattachMs,
  approveSetup,
}: {
  readonly site: MachineCheckSite;
  readonly started: LocalCheck;
  readonly wanted: LocalCheckRun;
  readonly name: string;
  readonly remoteHosts: RemoteHostsShape | undefined;
  readonly reattachMs: number;
  readonly approveSetup: (
    check: LocalCheck,
    hook: InspectedWorktreeHook,
    host: string,
    name: string,
  ) => Effect.Effect<WorktreeHookGrant | undefined>;
}) => {
  const failed = (reason: string, kind: LocalCheckFailure["kind"]) =>
    machineCheckFailure(name, reason, kind);
  return Effect.gen(function* () {
    let request: HostCheckRequest = {
      id: randomUUID(),
      path: site.path,
      ...(site.repoRoot === undefined ? {} : { repoRoot: site.repoRoot }),
      head: started.head,
      base: started.base,
      command: wanted.command,
      ...(wanted.setup === undefined ? {} : { setup: wanted.setup }),
      ...(wanted.repositorySetup === true ? { repositorySetup: {} } : {}),
      timeoutMs: wanted.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
    };
    if (wanted.refusal !== undefined) return failed(wanted.refusal, "unstartable");
    if (remoteHosts === undefined)
      return failed(`${name} isn't joined to this Gram`, "unstartable");
    let deadline = (yield* Clock.currentTimeMillis) + request.timeoutMs + MACHINE_SLACK_MS;
    let away: number | undefined;
    let asked = false;
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline)
        return failed(
          `no word from ${name} on how its check ended, past its timeout; run local_check again`,
          "stopped",
        );
      if (away !== undefined && now - away >= reattachMs)
        return asked
          ? failed(
              `the connection to ${name} dropped while its check ran and didn't come back in time, so how it ended is unknown; run local_check again`,
              "stopped",
            )
          : failed(
              `${name} is offline, so its check couldn't run; run local_check again once it is back`,
              "unstartable",
            );
      const connection = yield* remoteHosts.connection(site.hostId).pipe(Effect.option);
      if (Option.isNone(connection)) {
        away ??= now;
        yield* Effect.sleep(Math.min(MACHINE_POLL_MS, reattachMs));
        continue;
      }
      const checks = connection.value.checks;
      if (checks === undefined)
        return failed(
          `${name}'s gram-host is older than this Gram and runs no local checks; run the install command there again to update it`,
          "unstartable",
        );
      if (
        wanted.repositorySetup === true &&
        !hostServes(connection.value.hello, "repository-check-setup")
      )
        return failed(
          `${name}'s host needs an update to run repository checks with setup.`,
          "unstartable",
        );
      asked = true;
      const answer = yield* checks.run(request).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(0, deadline - now)),
          orElse: () =>
            Effect.succeed(
              failed(
                `no word from ${name} on how its check ended, past its timeout; run local_check again`,
                "stopped",
              ),
            ),
        }),
        Effect.exit,
      );
      if (Exit.isSuccess(answer)) {
        const result = withHostCheckDiagnostic(answer.value);
        const hook = result.setupApproval;
        if (wanted.repositorySetup === true && hook !== undefined) {
          if (
            result.ok ||
            result.setupRunnerVersion !== WORKTREE_HOOK_VERSION ||
            request.repositorySetup?.fingerprint !== undefined ||
            result.mergedCommit !== hook.revision ||
            !SHA.test(hook.revision) ||
            !/^[a-f0-9]{64}$/.test(hook.fingerprint)
          )
            return failed(`${name} returned an invalid repository setup preview.`, "unstartable");
          const grant = yield* approveSetup(started, hook, site.hostId, name);
          if (grant?.host !== site.hostId)
            return failed("Repository setup was not approved for this check.", "unstartable");
          request = {
            ...request,
            id: randomUUID(),
            repositorySetup: { fingerprint: grant.fingerprint, revision: grant.revision },
          };
          deadline = (yield* Clock.currentTimeMillis) + request.timeoutMs + MACHINE_SLACK_MS;
          away = undefined;
          asked = false;
          continue;
        }
        if (
          wanted.repositorySetup === true &&
          result.ok &&
          (request.repositorySetup?.fingerprint === undefined ||
            result.setupRunnerVersion !== WORKTREE_HOOK_VERSION ||
            result.setupFingerprint !== request.repositorySetup.fingerprint ||
            result.mergedCommit !== request.repositorySetup.revision)
        )
          return failed(`${name}'s pass named no approved repository setup.`, "unstartable");
        return result.ok &&
          (result.tree === null ||
            !SHA.test(result.tree) ||
            result.mergedCommit === undefined ||
            !SHA.test(result.mergedCommit))
          ? failed(`${name}'s pass named no merged tree and commit`, "unstartable")
          : result;
      }
      const error = Cause.findErrorOption(answer.cause);
      if (Option.isSome(error) && error.value._tag === "HostFailed")
        return failed(`${name} couldn't run it: ${error.value.message}`, "unstartable");
      if (Option.isNone(error)) return yield* Effect.failCause(answer.cause);
      away = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("local check: a joined machine's connection dropped mid-check").pipe(
        Effect.annotateLogs({ hostId: site.hostId, head: started.head }),
      );
      yield* Effect.sleep(Math.min(MACHINE_POLL_MS, reattachMs));
    }
  });
};
