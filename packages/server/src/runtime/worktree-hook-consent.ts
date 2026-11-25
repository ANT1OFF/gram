import { createHash } from "node:crypto";
import { type Thread, type WorktreeHookKind } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { privateJsonFile } from "../http/remote-sessions.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

const consentLock = makeKeyedLock<string>();

export const worktreeHookConsent = (options: {
  readonly dataDir: string;
  readonly thread: Pick<Thread, "id" | "startedBy">;
  readonly host: string;
  readonly machine: string;
  readonly repository: string;
  readonly kind: WorktreeHookKind;
  readonly path: string;
  readonly fingerprint: string;
  readonly script: string;
  readonly ask: ThreadRuntimesShape["requestApproval"];
}) => {
  const { dataDir, thread, host, machine, repository, kind, path, fingerprint, script, ask } =
    options;
  const key = createHash("sha256")
    .update(JSON.stringify([thread.startedBy ?? null, host, repository, kind, path, fingerprint]))
    .digest("hex");
  return consentLock
    .withLock(
      `${dataDir}\0${key}`,
      Effect.gen(function* () {
        const file = yield* Effect.try(() =>
          privateJsonFile(dataDir, `worktree-hook-${key}.json`, 128),
        );
        const prior = yield* Effect.try(file.read);
        if (prior === "allow" || prior === "deny") return prior;
        if (prior !== undefined) return "unavailable" as const;
        const answer = yield* ask(thread.id, {
          toolName: "mcp__gram__worktree_hook",
          displayName: kind === "setup" ? "Worktree setup hook" : "Worktree resume hook",
          description:
            "Allow this committed hook and the repository commands it calls on this machine? Gram remembers this decision for these hook contents.",
          input: { command: script, machine, repository, path },
          suggestions: [],
          scopes: ["once"],
        });
        if (answer.resolution?.origin !== "user" || answer.answeredBy !== thread.startedBy)
          return "unavailable" as const;
        yield* Effect.try(() => file.write(answer.decision));
        return answer.decision;
      }),
    )
    .pipe(Effect.orElseSucceed(() => "unavailable" as const));
};
