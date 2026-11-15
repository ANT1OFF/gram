// Gram's own check of a dream's output when it says done: sent back once, then reviewed as left.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { hasGit } from "../git/test-repo.ts";
import { Dreams } from "./dreams.ts";
import { completeTurn, openOrchestrator, waitSent } from "./test-harness.ts";
import { finishDream, inDreams, startDream, waitDream, writeOutput } from "./dreams-service-kit.ts";

const note = (name: string, description: string, body = "") =>
  `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\n${body}\n`;

describe.skipIf(!hasGit)("a dream's check", () => {
  it.effect("sends a dream back once for a broken link, then shows what it left", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        writeOutput(dream, {
          "MEMORY.md": "# Memory index\n\n- [[deploy]]: deploy order\n- [[ci]]: CI\n",
          "deploy.md": note("deploy", "Which service deploys first", "See [[rollbacks]]."),
          "ci.md": note("ci", "How CI runs"),
        });

        // Said done with a link to no note: sent back with the list, still running.
        yield* completeTurn(session, "done");
        const back = yield* waitSent(dream.threadId!, 2);
        expect(back.sent[1]?.text).toContain("[[rollbacks]] names no note");
        expect(back.sent[1]?.text).toContain("reply with the single word: done");
        expect((yield* dreams.list(workspaceId)).find((d) => d.id === dream.id)?.status).toBe(
          "running",
        );

        // Done again without fixing it: never asked twice; the reviewer sees what was left.
        yield* finishDream(dream, session, "completed");
        const review = yield* dreams.review(dream.id);
        expect(review.report).toContain("## Checks by Gram");
        expect(review.report).toContain("deploy.md: [[rollbacks]] names no note");
        expect(review.report).toContain("Reviewed the synthetic input");
      }),
    ),
  );

  it.effect("finishes a dream whose output checks clean at once", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        writeOutput(dream, {
          "MEMORY.md": "# Memory index\n\n- [[deploy]]: deploy order\n",
          "deploy.md": note("deploy", "Which service deploys first"),
        });
        yield* finishDream(dream, session, "completed");
        expect(session.sent).toHaveLength(1);
        expect((yield* dreams.review(dream.id)).report).not.toContain("Checks by Gram");
        yield* waitDream(dream.id, "completed");
      }),
    ),
  );
});
