import { createHash, randomUUID } from "node:crypto";
import {
  hidesText,
  type Thread,
  type WorktreeHookKind,
  type WorktreeHookOutcome,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import { worktreeHookFingerprint } from "../host/worktree-hook-source.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

const consentLock = makeKeyedLock<string>();

const WORKTREE_HOOK_APPROVAL = "mcp__gram__worktree_hook";

export interface WorktreeHookGrant {
  readonly host: string;
  readonly revision: string;
  readonly path: string;
  readonly fingerprint: string;
}

type HookConsent =
  | { readonly decision: "allow"; readonly grant: WorktreeHookGrant }
  | {
      readonly decision: "deny" | "unavailable";
      readonly result: WorktreeHookOutcome & { readonly status: "skipped" };
    };

const skipped = (decision: "deny" | "unavailable", reason: string): HookConsent => ({
  decision,
  result: { status: "skipped", durationMs: 0, log: "", reason },
});

const unavailable = skipped(
  "unavailable",
  "Gram could not establish local app consent for this hook revision.",
);
const untrusted = skipped("unavailable", "The project folder or checkout is not trusted.");
const denied = skipped("deny", "The user declined this hook revision.");

export const worktreeHookConsent = (options: {
  readonly dataDir: string;
  readonly thread: Pick<Thread, "id" | "startedBy">;
  readonly host: string;
  readonly machine: string;
  readonly repository: string;
  readonly kind: WorktreeHookKind;
  readonly path: string;
  readonly revision: string;
  readonly fingerprint: string;
  readonly script: string;
  readonly folderTrusted: Effect.Effect<boolean>;
  readonly ask: ThreadRuntimesShape["requestApproval"];
}): Effect.Effect<HookConsent> => {
  const {
    dataDir,
    thread,
    host,
    machine,
    repository,
    kind,
    path,
    revision,
    fingerprint,
    script,
    folderTrusted,
    ask,
  } = options;
  if (hidesText(script) || worktreeHookFingerprint(path, script) !== fingerprint)
    return Effect.succeed(unavailable);
  const allowed: HookConsent = { decision: "allow", grant: { host, revision, path, fingerprint } };
  const key = createHash("sha256")
    .update(JSON.stringify([thread.startedBy ?? null, host, repository, kind, path, fingerprint]))
    .digest("hex");
  return consentLock
    .withLock(
      `${dataDir}\0${key}`,
      Effect.gen(function* () {
        if (!(yield* folderTrusted)) return untrusted;
        const file = yield* Effect.try(() =>
          privateJsonFile(dataDir, `worktree-hook-${key}.json`, 128),
        );
        const prior = yield* Effect.try(file.read);
        if (prior === "allow") return allowed;
        if (prior === "deny") return denied;
        if (prior !== undefined) return unavailable;
        const answer = yield* ask(thread.id, "localAppOnly", {
          toolName: WORKTREE_HOOK_APPROVAL,
          displayName: kind === "setup" ? "Worktree setup hook" : "Worktree resume hook",
          description:
            "Allow this committed hook and the repository commands it calls on this machine? Gram remembers this decision for these hook contents.",
          input: { command: script, machine, repository, path, phase: kind },
          suggestions: [],
          scopes: ["once"],
          shown: randomUUID(),
        });
        if (answer.resolution?.origin !== "user" || answer.answeredBy !== thread.startedBy)
          return unavailable;
        if (!(yield* folderTrusted)) return untrusted;
        yield* Effect.try(() => file.write(answer.decision));
        return answer.decision === "allow" ? allowed : denied;
      }),
    )
    .pipe(Effect.orElseSucceed(() => unavailable));
};
