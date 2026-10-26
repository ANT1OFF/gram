import type { ThreadId, TurnId } from "../ids.ts";
import type { GramUIMessage, GramUIMessageChunk } from "../ui-message.ts";

// Long generated transcripts for performance checks: no model, deterministic text.

export interface LongTranscriptOptions {
  /** Prefix for message and turn ids, unique per thread. */
  readonly threadId: ThreadId | string;
  readonly turns: number;
  /** Bytes of Bash output per turn; heavy by default. */
  readonly toolOutputBytes?: number;
  /** Diff lines in each turn's Edit. */
  readonly diffLines?: number;
  /** `createdAt` of the first message; later ones step a second each. */
  readonly startAt?: number;
}

const WORDS =
  "retry clock timer flaky assertion fixture deterministic reject resolve worker queue cache index schema migration".split(
    " ",
  );

const sentence = (seed: number, words: number) =>
  Array.from({ length: words }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(" ");

/** `bytes` of plausible test-runner output. */
const logOutput = (seed: number, bytes: number) => {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `  ✓ src/${WORDS[(seed + i) % WORDS.length]}.test.ts > ${sentence(seed + i, 6)} (${(seed * 13 + i) % 97} ms)`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
};

/**
 * `turns` user prompts, each answered by one assistant message with reasoning, a Bash run with heavy
 * output, an Edit with a structured patch, and a markdown reply with a list and a code block.
 */
export function longTranscript(options: LongTranscriptOptions): GramUIMessage[] {
  const { threadId, turns, toolOutputBytes = 8_000, diffLines = 40 } = options;
  const startAt = options.startAt ?? 1_700_000_000_000;
  const messages: GramUIMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const turnId = `${threadId}-turn-${turn}` as TurnId;
    const createdAt = startAt + turn * 2_000;
    messages.push({
      id: `${threadId}-u${turn}`,
      role: "user",
      metadata: { createdAt, turnId },
      parts: [{ type: "text", text: `Turn ${turn}: ${sentence(turn, 12)}.` }],
    });
    const file = `src/${WORDS[turn % WORDS.length]}.ts`;
    const patch = Array.from({ length: diffLines }, (_, i) =>
      i % 3 === 0
        ? `-  const ${WORDS[i % WORDS.length]} = ${i};`
        : i % 3 === 1
          ? `+  const ${WORDS[i % WORDS.length]} = ${i + 1};`
          : `   ${sentence(turn + i, 5)}`,
    );
    messages.push({
      id: `${threadId}-a${turn}`,
      role: "assistant",
      metadata: {
        createdAt: createdAt + 1_000,
        agent: "claude",
        model: "opus",
        agentMessageIds: [`sdk-${threadId}-a${turn}`],
        turnId,
      },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: sentence(turn, 40), state: "done" },
        {
          type: "tool-Bash",
          toolCallId: `${threadId}-bash-${turn}`,
          state: "output-available",
          input: { command: "pnpm vitest run", description: "Run the tests" },
          output: { stdout: logOutput(turn, toolOutputBytes), stderr: "", interrupted: false },
        },
        {
          type: "tool-Edit",
          toolCallId: `${threadId}-edit-${turn}`,
          state: "output-available",
          input: { file_path: file, old_string: "const a = 1;", new_string: "const a = 2;" },
          output: {
            filePath: file,
            oldString: "const a = 1;",
            newString: "const a = 2;",
            originalFile: null,
            structuredPatch: [
              {
                oldStart: 10,
                oldLines: diffLines,
                newStart: 10,
                newLines: diffLines,
                lines: patch,
              },
            ],
            userModified: false,
          },
        },
        {
          type: "text",
          state: "done",
          text: [
            `Turn ${turn} is done. ${sentence(turn + 1, 30)}.`,
            "",
            `- ${sentence(turn + 2, 8)}`,
            `- ${sentence(turn + 3, 8)}`,
            "",
            "```ts",
            `export const ${WORDS[turn % WORDS.length]} = ${turn};`,
            "```",
          ].join("\n"),
        },
      ],
    });
  }
  return messages;
}

export interface LongTurnOptions {
  /** The streaming message's id. */
  readonly messageId: string;
  /** Agent steps in the turn, each reasoning, a Bash run and a line of text. */
  readonly steps: number;
  /** Characters per streamed delta, as the agent's SDK sends them. */
  readonly delta?: number;
  /** Bytes of Bash output per step. */
  readonly toolOutputBytes?: number;
}

/**
 * The chunks of one long agent turn still streaming: every step's reasoning, tool input and text
 * arrive in small deltas, and no `finish` closes it. A subscriber that joins mid-turn is replayed
 * all of them.
 */
export function longTurnChunks(options: LongTurnOptions): GramUIMessageChunk[] {
  const { messageId, steps, delta = 24, toolOutputBytes = 2_000 } = options;
  const pieces = (text: string) =>
    Array.from({ length: Math.ceil(text.length / delta) }, (_, i) =>
      text.slice(i * delta, (i + 1) * delta),
    );
  const chunks: GramUIMessageChunk[] = [
    { type: "start", messageId, messageMetadata: { createdAt: 1_700_000_000_000 } },
  ];
  for (let step = 0; step < steps; step++) {
    const toolCallId = `${messageId}-bash-${step}`;
    const input = { command: `pnpm vitest run ${WORDS[step % WORDS.length]}`, description: "Test" };
    chunks.push(
      { type: "start-step" },
      { type: "reasoning-start", id: `r${step}` },
      ...pieces(sentence(step, 40)).map((d): GramUIMessageChunk => ({
        type: "reasoning-delta",
        id: `r${step}`,
        delta: d,
      })),
      { type: "reasoning-end", id: `r${step}` },
      { type: "tool-input-start", toolCallId, toolName: "Bash" },
      ...pieces(JSON.stringify(input)).map((d): GramUIMessageChunk => ({
        type: "tool-input-delta",
        toolCallId,
        inputTextDelta: d,
      })),
      { type: "tool-input-available", toolCallId, toolName: "Bash", input },
      {
        type: "tool-output-available",
        toolCallId,
        output: { stdout: logOutput(step, toolOutputBytes), stderr: "", interrupted: false },
      },
      { type: "text-start", id: `t${step}` },
      ...pieces(`Step ${step}: ${sentence(step + 1, 20)}.`).map((d): GramUIMessageChunk => ({
        type: "text-delta",
        id: `t${step}`,
        delta: d,
      })),
      { type: "text-end", id: `t${step}` },
      { type: "finish-step" },
    );
  }
  return chunks;
}
