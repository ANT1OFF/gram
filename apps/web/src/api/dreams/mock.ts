import { answerMessage, answerQuestion, QUESTIONS_FILE, questionDate } from "@gram/contracts";

import type { createMockDreams } from "../mock-dreams";
import { MockInvalidState } from "../mock-fs";
import type { createMockOrchestration } from "../mock-orchestration";
import type { MockWorld } from "../mock-world";
import type { DreamsApi } from "./types";

/** What the slice needs of the core: its dreams and orchestration mocks. */
export interface DreamsDeps {
  readonly dreams: ReturnType<typeof createMockDreams>;
  readonly orchestration: ReturnType<typeof createMockOrchestration>;
}

/** `DreamsApi` over the core's dreams mock; an answer goes to the workspace's orchestrator. */
export function createDreamsMock(
  world: MockWorld,
  { dreams, orchestration }: DreamsDeps,
): DreamsApi {
  return {
    automaticDreamStatus: async (workspaceId) => {
      const state = orchestration.peek().find((s) => s.workspace.id === workspaceId);
      const threshold = state?.charter.automaticDreamThreshold;
      return {
        ...(threshold === undefined ? {} : { threshold }),
        completed: 0,
        detail:
          threshold === undefined
            ? "Automatic Dream is off."
            : "Automatic runs await review. Counting distinct completed threads since the last start or setting edit.",
      };
    },
    listMemory: (workspaceId) => dreams.list(workspaceId),
    readMemory: (workspaceId, path) => dreams.read(workspaceId, path),
    writeMemory: (workspaceId, path, content) => dreams.write(workspaceId, path, content),
    deleteMemory: (workspaceId, path) => dreams.delete(workspaceId, path),
    listMemoryVersions: (workspaceId) => dreams.versions(workspaceId),
    restoreMemory: (workspaceId, version) => dreams.restore(workspaceId, version),
    answerQuestion: async (input) => {
      const state = orchestration.peek().find((each) => each.workspace.id === input.workspaceId);
      const orchestrator = state?.workspace.orchestratorThreadId;
      if (
        orchestrator === undefined ||
        !world.threads().some((s) => s.thread.id === orchestrator)
      ) {
        throw new MockInvalidState("This workspace has no orchestrator open to take the answer.");
      }
      const current = await dreams
        .read(input.workspaceId, QUESTIONS_FILE)
        .then((file) => file.content)
        .catch(() => undefined);
      const edit = answerQuestion(current, input, questionDate(Date.now()));
      if (!edit.ok) throw new MockInvalidState(edit.problem);
      await dreams.write(input.workspaceId, QUESTIONS_FILE, edit.content);
      const text = answerMessage({ id: edit.id, text: input.question }, input.answer);
      const running = world.running(orchestrator);
      if (running) await world.steer(orchestrator, { text });
      else await world.send(orchestrator, { text });
      return { questionId: edit.id, delivered: running ? ("steered" as const) : ("sent" as const) };
    },
    previewDream: (workspaceId, input) => dreams.preview(workspaceId, input),
    startDream: (workspaceId, input) => dreams.start(workspaceId, input),
    listDreams: (workspaceId) => dreams.listDreams(workspaceId),
    reviewDream: (dreamId) => dreams.review(dreamId),
    cancelDream: (dreamId) => dreams.cancel(dreamId),
    adoptDream: (dreamId, input) => dreams.adopt(dreamId, input),
    mergeDreamConflict: (dreamId, path) => dreams.merge(dreamId, path),
    discardDream: (dreamId) => dreams.discard(dreamId),
  };
}
