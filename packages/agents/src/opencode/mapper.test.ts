import { readFileSync } from "node:fs";

import type { AgentEvent, MessageId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { makeOpenCodeMapper, toolFor } from "./mapper.ts";
import { parseEvent, type OpenCodeEvent } from "./protocol.ts";

const recorded = (name: string): ReadonlyArray<OpenCodeEvent> =>
  readFileSync(new URL(`./fixtures/${name}.sse`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .flatMap((line) => {
      const event = parseEvent(line.slice(6));
      return event === undefined ? [] : [event];
    });

const sessionOf = (events: ReadonlyArray<OpenCodeEvent>, after = 0): string => {
  const created = events.filter((event) => event.type === "session.execution.started")[after];
  return created!.data["sessionID"] as string;
};

const mapperFor = (sessionId: string) => {
  let n = 0;
  return makeOpenCodeMapper({ sessionId, newMessageId: () => `m${++n}` as MessageId });
};

const chunks = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => (event.type === "chunk" ? [event.chunk.type] : []));

describe("the OpenCode mapper on a recorded turn with an approval", () => {
  const events = recorded("events-ask");
  const sessionId = sessionOf(events);
  const mapper = mapperFor(sessionId);
  const out = events.flatMap((event) => mapper.map(event));

  it("asks for the shell command as Claude Code's Bash, once or always", () => {
    const request = out.find((event) => event.type === "request");
    expect(request).toMatchObject({
      request: {
        kind: "approval",
        toolName: "Bash",
        toolUseId: "call_1",
        input: { command: "echo hi > made.txt", description: "Make a file" },
        scopes: ["once", "always"],
      },
    });
    const id = request?.type === "request" ? request.request.id : undefined;
    expect(out).toContainEqual({ type: "requestResolved", requestId: id });
  });

  it("streams one assistant message: the call, its result, then the text", () => {
    expect(chunks(out)).toEqual([
      "start",
      "start-step",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "message-metadata",
      "finish",
    ]);
    const text = out.flatMap((event) =>
      event.type === "chunk" && event.chunk.type === "text-delta" ? [event.chunk.delta] : [],
    );
    expect(text.join("")).toBe("Done, all good.");
    const result = out.find(
      (event) => event.type === "chunk" && event.chunk.type === "tool-output-available",
    );
    expect(result).toMatchObject({ chunk: { toolCallId: "call_1" } });
  });

  it("ends the turn completed, with its usage, and goes idle", () => {
    const tail = out.slice(-3);
    expect(tail[0]).toMatchObject({ type: "usage", tokens: { inputTokens: expect.any(Number) } });
    expect(tail.slice(1)).toEqual([
      { type: "turnEnd", reason: "completed" },
      { type: "status", status: "idle" },
    ]);
  });

  it("ignores another session's events", () => {
    const other = mapperFor("ses_someone_else");
    expect(events.flatMap((event) => other.map(event))).toEqual([]);
  });
});

const data = (rest: Record<string, unknown>) => ({ sessionID: "ses_1", ...rest });

describe("the OpenCode mapper", () => {
  it("ends a turn the user stopped, cancelling the call under way", () => {
    const mapper = mapperFor("ses_1");
    mapper.map({ type: "session.execution.started", data: data({}) });
    mapper.map({
      type: "session.tool.input.started",
      data: data({ assistantMessageID: "msg_1", id: "call_9", name: "read" }),
    });
    const out = mapper.map({
      type: "session.execution.interrupted",
      data: data({ reason: "user" }),
    });
    expect(out).toContainEqual(
      expect.objectContaining({
        chunk: expect.objectContaining({ type: "tool-output-error", errorText: "Cancelled" }),
      }),
    );
    expect(out.at(-2)).toEqual({ type: "turnEnd", reason: "interrupted" });
  });

  it("says why a turn failed", () => {
    const mapper = mapperFor("ses_1");
    mapper.map({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    const out = mapper.map({
      type: "session.execution.failed",
      data: {
        sessionID: "ses_1",
        error: { type: "api", message: "Insufficient credits", status: 402 },
      },
    });
    expect(out).toContainEqual({ type: "turnEnd", reason: "error", error: "Insufficient credits" });
  });

  it("names OpenCode's tools as Claude Code's", () => {
    expect(toolFor("edit", { path: "a.ts", oldString: "x", newString: "y" })).toEqual({
      name: "Edit",
      input: { file_path: "a.ts", old_string: "x", new_string: "y" },
    });
    expect(toolFor("grep", { pattern: "foo", include: "*.ts" })).toEqual({
      name: "Grep",
      input: { pattern: "foo", glob: "*.ts" },
    });
    expect(toolFor("github_create_issue", { title: "t" })).toEqual({
      name: "github_create_issue",
      input: { title: "t" },
    });
  });
});
