import { describe, expect, it } from "@effect/vitest";
import { parseQuestions } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { OrchestrationMemory } from "../memory.ts";
import { Orchestration } from "../service.ts";
import {
  makeWorld,
  openOrchestrator,
  outboxOf,
  withServer,
  type Server,
  type World,
} from "../test-harness.ts";

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const byId = (content: string) =>
  Object.fromEntries(parseQuestions(content).map((question) => [question.id, question]));

describe("the orchestrator's questions in the store", () => {
  it.effect("reads an edit to questions.md as asks and closes, and puts back what it lost", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const memory = yield* OrchestrationMemory;
        const { session, workspaceId } = yield* openOrchestrator(world);
        yield* session.callTool("ask_user", {
          question: "Which installer ships?",
        });
        yield* session.callTool("ask_user", {
          question: "Who signs the build?",
        });
        const read = (yield* session.callTool("memory_read", {
          path: "questions.md",
        })) as {
          readonly content: string;
          readonly revision: string;
        };
        const start = read.content.indexOf("## Q1");
        const end = read.content.indexOf("## Q2");
        const edited =
          read.content.slice(0, start) +
          read.content
            .slice(end)
            .replace(/## Q2 · open[^\n]*/, "## Q2 · decided 2026-11-21")
            .concat("Decided: the release team.\n\n## Q7 · open\nIs arm64 in scope?\n");
        const written = (yield* session.callTool("memory_write", {
          path: "questions.md",
          content: edited,
          revision: read.revision,
        })) as { readonly revision: string };

        const file = yield* memory.read(workspaceId, "questions.md");
        const questions = byId(file);
        expect(questions.Q1).toMatchObject({
          open: true,
          text: "Which installer ships?",
        });
        expect(questions.Q2).toMatchObject({
          open: false,
          closedAs: "decided",
        });
        expect(questions.Q7).toMatchObject({
          open: true,
          text: "Is arm64 in scope?",
        });
        const again = (yield* session.callTool("memory_read", {
          path: "questions.md",
        })) as {
          readonly revision: string;
        };
        expect(written.revision).toBe(again.revision);

        const stored = (yield* outboxOf(workspaceId)).memoryQuestions;
        expect(stored?.entries.map((entry) => [entry.question.id, entry.question.open])).toEqual([
          ["Q7", true],
          ["Q1", true],
          ["Q2", false],
        ]);

        yield* session.callTool("close_question", {
          id: "Q1",
          answer: "MSI.",
          how: "decided",
        });
        const orchestration = yield* Orchestration;
        expect(
          (yield* orchestration.memoryQuestions.list(workspaceId)).map((each) => each.open),
        ).toEqual([true, false, false]);
      }),
    ),
  );

  it.effect("takes a questions.md written before the store as it stands", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const memory = yield* OrchestrationMemory;
        const orchestration = yield* Orchestration;
        const { workspaceId } = yield* openOrchestrator(world);
        yield* memory.write(
          workspaceId,
          "questions.md",
          "# Questions\n\n## Open\n\n- Which installer ships?\n- [x] Who signs the build? (decided: release team)\n",
        );
        const listed = yield* orchestration.memoryQuestions.list(workspaceId);
        expect(listed.map((each) => [each.id, each.open])).toEqual([
          ["Q1", true],
          ["Q2", false],
        ]);
        expect((yield* outboxOf(workspaceId)).memoryQuestions?.entries).toHaveLength(2);
        expect(yield* memory.read(workspaceId, "questions.md")).toContain("## Q1 · open");
      }),
    ),
  );
});
