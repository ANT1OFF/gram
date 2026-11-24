import type { GramUIMessageChunk } from "@gram/contracts";

const PATH = "/Users/dev/code/api/src/rate-limit.ts";

const SOURCE = [
  'import { sleep } from "./clock";',
  "",
  ...Array.from({ length: 24 }, (_, index) => [
    `/** Bucket ${index + 1}: how many calls it lets through a window. */`,
    `export const bucket${index + 1} = {`,
    `  limit: ${(index + 1) * 10},`,
    `  windowMs: ${(index + 1) * 250},`,
    `  wait: (attempt: number) => sleep(${index + 1} * 2 ** attempt),`,
    "};",
    "",
  ]).flat(),
].join("\n");

const MOCK_CHART = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="480" height="240">',
  '<rect width="240" height="120" rx="6" fill="var(--surface)" stroke="var(--border)"/>',
  '<text x="12" y="20" font-family="var(--font)" font-size="10" fill="var(--fg)">p95 latency, ms</text>',
  ...[38, 64, 51, 82].map(
    (value, i) =>
      `<rect x="${20 + i * 54}" y="${104 - value}" width="36" height="${value}" rx="3" fill="var(--${i === 3 ? "warning" : "accent"})"/>`,
  ),
  '<line x1="12" y1="104" x2="228" y2="104" stroke="var(--fg-muted)"/>',
  "</svg>",
].join("");

type StreamedStep =
  | { kind: "chunk"; messageId: string; chunk: GramUIMessageChunk }
  | { kind: "wait"; ms: number };

/**
 * A Write whose input streams in a little at a time, as Claude Code sends a long file: the echo's
 * "write a long file". Its file change in the transcript grows line by line until the call is in.
 */
export function streamedWriteSteps(messageId: string, toolCallId: string): StreamedStep[] {
  const chunk = (value: GramUIMessageChunk): StreamedStep => ({
    kind: "chunk",
    messageId,
    chunk: value,
  });
  const input = { file_path: PATH, content: SOURCE };
  const deltas = JSON.stringify(input).match(/[\s\S]{1,160}/g) ?? [];
  return [
    chunk({ type: "tool-input-start", toolCallId, toolName: "Write", providerExecuted: true }),
    ...deltas.flatMap((inputTextDelta): StreamedStep[] => [
      chunk({ type: "tool-input-delta", toolCallId, inputTextDelta }),
      { kind: "wait", ms: 200 },
    ]),
    chunk({
      type: "tool-input-available",
      toolCallId,
      toolName: "Write",
      input,
      providerExecuted: true,
    }),
    { kind: "wait", ms: 200 },
    chunk({
      type: "tool-output-available",
      toolCallId,
      output: `File created successfully at: ${PATH}`,
      providerExecuted: true,
    }),
  ];
}

/** The echo's "chart": a widget the agent drew, as an SVG in the theme's colours. */
export const chartWidgetStep = (messageId: string): StreamedStep => ({
  kind: "chunk",
  messageId,
  chunk: {
    type: "data-widget",
    id: "w-latency",
    data: { id: "w-latency", title: "p95 latency by region", svg: MOCK_CHART },
  },
});
