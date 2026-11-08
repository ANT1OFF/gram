import type { GramUIMessageChunk, ToolTime } from "@gram/contracts";

// The mock's `toolTimes`, as the server stamps them (`stampToolTime`): when each tool call of a
// message starts and ends, sent as the message's whole map again on each change. Scripted turns
// play in milliseconds, and the shots hold the clock still, so the mock lets each call take a
// believable time of its own by tool, never less than the clock says.

/** How long a scripted call of each tool takes, in ms. */
const TAKES: Readonly<Record<string, number>> = {
  Bash: 6_200,
  Read: 400,
  Grep: 700,
  Glob: 500,
  Edit: 1_100,
  MultiEdit: 1_400,
  Write: 900,
  Task: 24_000,
  Agent: 24_000,
  WebFetch: 3_100,
  WebSearch: 2_400,
};
const TAKES_OTHERWISE = 1_500;
/** The model's own time between one call's end and the next one's start. */
const BETWEEN = 1_800;

export interface MockToolClock {
  /** When the next call may start at the earliest. */
  cursor: number;
  readonly times: Map<string, Record<string, ToolTime>>;
  readonly names: Map<string, string>;
}

export const mockToolClock = (): MockToolClock => ({
  cursor: 0,
  times: new Map(),
  names: new Map(),
});

/** The metadata chunk `chunk` makes for `messageId`, or `undefined` when it starts or ends no call. */
export function mockToolTime(
  clock: MockToolClock,
  messageId: string,
  chunk: GramUIMessageChunk,
  now: number,
): GramUIMessageChunk | undefined {
  if (chunk.type === "finish" || chunk.type === "abort") {
    clock.times.delete(messageId);
    return undefined;
  }
  const started = chunk.type === "tool-input-start" || chunk.type === "tool-input-available";
  const ended =
    (chunk.type === "tool-output-available" && chunk.preliminary !== true) ||
    chunk.type === "tool-output-error" ||
    chunk.type === "tool-output-denied" ||
    chunk.type === "tool-input-error";
  if (!started && !ended) return undefined;
  const { toolCallId } = chunk;
  const times = clock.times.get(messageId) ?? {};
  const was = times[toolCallId];
  let time: ToolTime;
  if (started) {
    if (was !== undefined) return undefined;
    const startedAt = Math.max(now, clock.cursor);
    clock.cursor = startedAt;
    clock.names.set(toolCallId, chunk.toolName);
    time = { startedAt };
  } else {
    if (was === undefined || was.endedAt !== undefined) return undefined;
    const takes = TAKES[clock.names.get(toolCallId) ?? ""] ?? TAKES_OTHERWISE;
    const endedAt = Math.max(now, was.startedAt + takes);
    clock.cursor = endedAt + BETWEEN;
    time = { startedAt: was.startedAt, endedAt };
  }
  const next = { ...times, [toolCallId]: time };
  clock.times.set(messageId, next);
  return { type: "message-metadata", messageMetadata: { toolTimes: next } };
}
