import { writeFileSync } from "node:fs";
import {
  DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
  type InspectedWorktreeHook,
  LOCAL_HOST_ID,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { runWorktreeHook } from "../host/worktree-hook-runner.ts";
import type { WorktreeHookSource } from "../host/worktree-hook-source.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { worktreeHookConsent } from "../runtime/worktree-hook-consent.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { folderBringsNothing, projectFolderTrusted } from "../settings/folder-trust.ts";
import type { LocalCheckOutcome } from "./check-process.ts";

export const repositorySetupRefused = (reason: string): LocalCheckOutcome => ({
  ok: false,
  reason,
  failure: { kind: "unstartable" },
});

export const approveRepositoryCheck = (options: {
  readonly store: Pick<ThreadStoreShape, "getThread" | "listProjects">;
  readonly dataDir: string;
  readonly ask: ThreadRuntimesShape["requestApproval"] | undefined;
  readonly threadId: ThreadId | undefined;
  readonly projectId: string | undefined;
  readonly host: string;
  readonly machine: string;
  readonly hook: InspectedWorktreeHook;
}) =>
  Effect.gen(function* () {
    const { store, dataDir, ask, threadId, projectId, host, machine, hook } = options;
    if (threadId === undefined || ask === undefined || projectId === undefined) return false;
    const thread = yield* store.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    if (thread === undefined || thread.projectId !== projectId) return false;
    const trusted = store.listProjects.pipe(
      Effect.map((projects) => {
        const project = projects.find((each) => each.id === projectId);
        return project !== undefined &&
          projectFolderTrusted(
            project,
            host === LOCAL_HOST_ID ? folderBringsNothing(project.root) : () => false,
          )
          ? project
          : undefined;
      }),
    );
    const project = yield* trusted;
    if (project === undefined) return false;
    const consent = yield* worktreeHookConsent({
      ...hook,
      dataDir,
      thread,
      host,
      machine,
      repository: project.originIdentity ?? project.id,
      kind: "setup",
      ask,
    });
    return consent === "allow" && (yield* trusted) !== undefined;
  });

/** Runs the checked-out repository hook under its own environment and the shared check deadline. */
export const runRepositoryCheckSetup = (options: {
  readonly checkout: string;
  readonly source: WorktreeHookSource;
  readonly fingerprint: string;
  readonly loginPath: string;
  readonly stagingRoot: string;
  readonly log: string;
  readonly timeoutMs?: number;
  readonly retain: () => void;
}) =>
  Effect.gen(function* () {
    const timeout = options.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS;
    const beganAt = Date.now();
    const hook = yield* runWorktreeHook(options.checkout, options.source, {
      approvedFingerprint: options.fingerprint,
      stagingRoot: options.stagingRoot,
      loginPath: options.loginPath,
      budgetMs: timeout,
      interrupted: (result) =>
        Effect.sync(() => {
          if (result.status === "failed" && result.failure === "cleanup") options.retain();
        }),
    });
    const output = `Worktree setup ${options.source.path}\n${hook.log === "" ? "" : `${hook.log.trimEnd()}\n`}`;
    const remaining = timeout - (Date.now() - beganAt);
    if (hook.status === "passed" && remaining > 0)
      return { status: "ready" as const, remaining, output };
    const reason = hook.status === "failed" ? hook.reason : "The setup and check deadline elapsed.";
    const kind =
      hook.status === "passed" || hook.failure === "timeout"
        ? "timed-out"
        : hook.failure === "missing-tool"
          ? "not-found"
          : hook.failure === "exited"
            ? "exited"
            : "unstartable";
    if (hook.status === "failed" && hook.failure === "cleanup") options.retain();
    yield* Effect.try(() => writeFileSync(options.log, output, { mode: 0o600 })).pipe(
      Effect.ignore,
    );
    return {
      status: "failed" as const,
      outcome: {
        ok: false,
        reason: `Repository setup failed. ${reason}`,
        failure: {
          kind,
          ...(hook.status === "failed" && hook.exitCode !== undefined
            ? { exitCode: hook.exitCode }
            : {}),
        },
      } satisfies LocalCheckOutcome,
    };
  });
