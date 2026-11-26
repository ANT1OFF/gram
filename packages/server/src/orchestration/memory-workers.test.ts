// A rule the user saves in the memory editor reaches a fresh orchestrator session and the workers
// it starts alike (G-SS-04): a worker reads the same file, with nothing of the rule in its brief.
// And where a worker can't read a file, or a line of it, it and the editor are told which and why.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { dreamHandlers } from "./dream-handler.ts";
import { inDreams } from "./dreams-service-kit.ts";
import { Orchestration } from "./service.ts";
import { completeTurn, openOrchestrator, spawn, waitReal } from "./test-harness.ts";

// Dated and sourced as the index asks: a workspace slug and the thread it came from, both of which
// were once taken for tokens and hid the whole index from every worker.
const RULE =
  "- 2026-11-19 (qa-2026-11-19-use-cases, from thread 6b4c4c3d-7cb9-585e-aa23-6b2705f071cf): we squash-merge every pull request.";

// Synthetic infrastructure notes, of the kind that once hid every note from every worker: an ARN's
// colons were taken for a password-file record, and a code span closing after `login` for a value.
const INFRA = [
  "# Infra",
  "",
  "- 2026-11-20: deploys run as AWS profile `trading-prod` in account 123456789012.",
  "- Sign in with `aws --profile trading-prod sso login` first.",
  "- kubectl context arn:aws:eks:eu-north-1:123456789012:cluster/trading-main.",
  "- Set AWS_PROFILE=trading-prod for the deploy script.",
  "",
].join("\n");

describe("workspace memory, for an orchestrator and its workers alike", () => {
  it.effect(
    "a rule saved in the editor reaches a fresh orchestrator and a worker it then starts",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const handlers = yield* dreamHandlers;
          const orchestration = yield* Orchestration;
          const fake = yield* FakeAgentControl;
          const { session, thread, workspaceId } = yield* openOrchestrator(world);

          // The editor: read the index, add the rule, save.
          const index = yield* handlers["memory.read"]({ workspaceId, path: "MEMORY.md" });
          yield* handlers["memory.write"]({
            workspaceId,
            path: "MEMORY.md",
            content: `${index.content.trimEnd()}\n\n${RULE}\n`,
          });
          const saved = yield* handlers["memory.read"]({ workspaceId, path: "MEMORY.md" });
          expect(saved.content).toContain(RULE);
          expect(saved.keptFromWorkers).toBeUndefined();

          // A fresh orchestrator session boots from it.
          yield* orchestration.handoff(workspaceId, "user", undefined, { checkpoint: false });
          const fresh = yield* waitReal(
            "the fresh session's boot digest",
            Effect.sync(() =>
              fake.sessions.find(
                (s) => s !== session && s.options.threadId === thread.id && s.sent.length > 0,
              ),
            ),
          );
          yield* completeTurn(fresh);

          // A worker it starts, briefed without the rule, reads the same file.
          const worker = yield* spawn(fresh, { feature: "merge-rule" });
          expect(worker.session.sent.map((sent) => sent.text).join("\n")).not.toContain(
            "squash-merge",
          );
          const listed = (yield* worker.session.callTool("memory_list", {})) as {
            readonly files: ReadonlyArray<{ readonly path: string }>;
            readonly keptFromWorkers?: unknown;
          };
          expect(listed.files.map((file) => file.path)).toContain("MEMORY.md");
          expect(listed.keptFromWorkers).toBeUndefined();
          const read = (yield* worker.session.callTool("memory_read", { file: "MEMORY.md" })) as {
            readonly content: string;
          };
          expect(read.content).toContain(RULE);
        }),
      ),
  );

  it.effect("a worker reads a note with an ARN, an account id and a profile name in it", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const handlers = yield* dreamHandlers;
        const { session, workspaceId } = yield* openOrchestrator(world);
        yield* handlers["memory.write"]({ workspaceId, path: "repos/infra.md", content: INFRA });
        const editor = yield* handlers["memory.read"]({ workspaceId, path: "repos/infra.md" });
        expect(editor.keptFromWorkers).toBeUndefined();

        const worker = yield* spawn(session, { feature: "infra-reader" });
        const listed = (yield* worker.session.callTool("memory_list", {})) as {
          readonly files: ReadonlyArray<{ readonly path: string }>;
          readonly keptFromWorkers?: unknown;
        };
        expect(listed.files.map((file) => file.path)).toContain("repos/infra.md");
        expect(listed.keptFromWorkers).toBeUndefined();
        const read = (yield* worker.session.callTool("memory_read", {
          file: "repos/infra.md",
        })) as {
          readonly content: string;
        };
        expect(read.content).toBe(INFRA);
      }),
    ),
  );

  it.effect("withholds the line a worker can't read, names it and why, and shows the rest", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const handlers = yield* dreamHandlers;
        const { session, workspaceId } = yield* openOrchestrator(world);
        yield* handlers["memory.write"]({
          workspaceId,
          path: "MEMORY.md",
          content:
            "# Memory index\n\n## Conventions\n\n- We squash-merge.\n\n## Staging\n\n- The staging deploy key is in the vault.\n",
        });
        const editor = yield* handlers["memory.read"]({ workspaceId, path: "MEMORY.md" });
        expect(editor.keptFromWorkers).toBe(
          "Workers read this file without line 9 (something shaped like a credential)",
        );

        const worker = yield* spawn(session, { feature: "reader" });
        const listed = (yield* worker.session.callTool("memory_list", {})) as {
          readonly files: ReadonlyArray<{ readonly path: string }>;
          readonly keptFromWorkers?: ReadonlyArray<{ path: string; reason: string }>;
        };
        // Listed, and named as read without that line, with why.
        expect(listed.files.map((file) => file.path)).toContain("MEMORY.md");
        expect(listed.keptFromWorkers).toEqual([
          { path: "MEMORY.md", reason: "read without line 9 (something shaped like a credential)" },
        ]);
        const read = (yield* worker.session.callTool("memory_read", { file: "MEMORY.md" })) as {
          readonly content: string;
        };
        expect(read.content).toBe(
          "# Memory index\n\n## Conventions\n\n- We squash-merge.\n\n## Staging\n\n- [line 9 withheld from workers]\n",
        );
        // What it reads with a line withheld, it can't write over.
        const refused = yield* worker.session
          .callTool("memory_append", { file: "MEMORY.md", text: "- [[notes]]: more." })
          .pipe(Effect.flip);
        expect(refused.message).toContain("kept_from_workers");
      }),
    ),
  );

  it.effect(
    "names a note a worker can't read any of, and why, to the worker and in the editor",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const handlers = yield* dreamHandlers;
          const { session, workspaceId } = yield* openOrchestrator(world);
          yield* handlers["memory.write"]({
            workspaceId,
            path: "staging.md",
            content: "The staging deploy key is in the vault.\n",
          });
          const editor = yield* handlers["memory.read"]({ workspaceId, path: "staging.md" });
          expect(editor.keptFromWorkers).toBe(
            "Workers can't read this file: line 1 has something shaped like a credential",
          );

          const worker = yield* spawn(session, { feature: "reader" });
          const listed = (yield* worker.session.callTool("memory_list", {})) as {
            readonly files: ReadonlyArray<{ readonly path: string }>;
            readonly keptFromWorkers?: ReadonlyArray<{ path: string; reason: string }>;
          };
          // Not an empty memory: the note is there, held back, with why.
          expect(listed.files.map((file) => file.path)).not.toContain("staging.md");
          expect(listed.keptFromWorkers).toEqual([
            { path: "staging.md", reason: "line 1 has something shaped like a credential" },
          ]);
          const refused = yield* worker.session
            .callTool("memory_read", { file: "staging.md" })
            .pipe(Effect.flip);
          expect(refused.message).toContain("kept_from_workers");
          expect(refused.message).toContain("line 1 has something shaped like a credential");
          expect(refused.message).not.toContain("vault");
        }),
      ),
  );
});
