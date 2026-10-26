import type { GramUIMessage, GramUIMessageChunk } from "@gram/contracts";
import { readUIMessageStream } from "ai";
import { describe, expect, it } from "vitest";
import { splitSubagents } from "@/thread/parts";
import { runningSubagents } from "@/thread/subagent-strip-model";
import { backgroundSubagentScript, type Step } from "./mock-scripts";

const assemble = async (steps: readonly Step[]): Promise<GramUIMessage[]> => {
  const lanes = new Map<string, GramUIMessageChunk[]>();
  for (const step of steps) {
    if (step.kind !== "chunk") continue;
    const lane = lanes.get(step.messageId) ?? [];
    lane.push(step.chunk);
    lanes.set(step.messageId, lane);
  }
  const messages: GramUIMessage[] = [];
  for (const chunks of lanes.values()) {
    let latest: GramUIMessage | undefined;
    for await (const message of readUIMessageStream<GramUIMessage>({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      onError(error) {
        throw error;
      },
    })) {
      latest = message;
    }
    if (latest) messages.push(latest);
  }
  return messages;
};

describe("invented background subagent mock", () => {
  it("keeps the child linked and visible across parent idle until the report is released", async () => {
    let next = 0;
    const steps = backgroundSubagentScript({ text: "scan" }, () => `m${++next}`);
    const gate = steps.findIndex((step) => step.kind === "gate" && step.name === "subagent-report");
    expect(gate).toBeGreaterThan(0);
    const before = steps.slice(0, gate);
    const split = splitSubagents(await assemble(before));
    expect(split.top.map((message) => message.id)).toEqual(["m1"]);
    expect([...split.children.keys()]).toEqual(["toolu_fixture_0023"]);
    expect(split.children.get("toolu_fixture_0023")?.map((message) => message.id)).toEqual(["m2"]);
    expect(before.filter((step) => step.kind === "status").at(-1)).toMatchObject({
      status: "idle",
    });
    expect(before.filter((step) => step.kind === "background").at(-1)).toMatchObject({
      tasks: [{ taskId: "fixture-explore", toolCallId: "toolu_fixture_0023", kind: "subagent" }],
    });
    expect(
      runningSubagents({
        top: split.top,
        children: split.children,
        usage: split.subagentUsage,
        streamingIds: new Set(["m2"]),
      }),
    ).toMatchObject([{ toolCallId: "toolu_fixture_0023", subagentType: "Explore", note: "Glob" }]);

    const completed = splitSubagents(await assemble(steps));
    expect(completed.top.map((message) => message.id)).toEqual(["m1", "m3"]);
    expect(completed.children.get("toolu_fixture_0023")).toHaveLength(1);
    expect(completed.subagentUsage.get("toolu_fixture_0023")).toMatchObject({
      status: "completed",
      totalTokens: 5_380,
      toolUses: 2,
    });
    expect(
      runningSubagents({
        top: completed.top,
        children: completed.children,
        usage: completed.subagentUsage,
        streamingIds: new Set(),
      }),
    ).toEqual([]);
    expect(steps.filter((step) => step.kind === "background").at(-1)).toEqual({
      kind: "background",
      tasks: [],
    });
    expect(completed.top.at(-1)?.parts.filter((part) => part.type === "text")).toMatchObject([
      { text: "DONE" },
    ]);
  });
});
