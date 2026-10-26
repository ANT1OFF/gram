import type { GramUIMessage, GramUIMessageChunk } from "@gram/contracts";
import { readUIMessageStream } from "ai";
import { expect, it } from "vitest";

import { createMessageFold } from "./message-fold";

const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as GramUIMessage;
const sdk = async (chunks: GramUIMessageChunk[], base?: GramUIMessage) => {
  const stream = new ReadableStream<GramUIMessageChunk>({
    start(controller) {
      if (!base) controller.enqueue({ type: "start", messageId: "m1" });
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
  let last: GramUIMessage | undefined;
  for await (const message of readUIMessageStream<GramUIMessage>({
    stream,
    ...(base ? { message: base } : {}),
  }))
    last = message;
  return stored(last);
};

for (const dynamic of [false, true]) {
  const start: GramUIMessageChunk[] = [
    { type: "tool-input-start", toolCallId: "tool", toolName: "Bash", dynamic },
    { type: "tool-input-delta", toolCallId: "tool", inputTextDelta: '{"command":"echo' },
  ];
  it(`retains streamed raw input for ${dynamic ? "dynamic" : "static"} tools after JSON reload`, async () => {
    const fold = createMessageFold("m1");
    start.forEach(fold.apply);
    await fold.parsePartialInputs();
    expect(stored(fold.snapshot())).toEqual(await sdk(start));
    expect(fold.snapshot().parts[0]).toMatchObject({
      input: { command: "echo" },
      rawInput: '{"command":"echo',
    });
  });

  it(`continues ${dynamic ? "dynamic" : "static"} tool input from a stored prefix`, async () => {
    const base = await sdk(start);
    const rest: GramUIMessageChunk[] = [
      { type: "tool-input-delta", toolCallId: "tool", inputTextDelta: ' audit"}' },
    ];
    const fold = createMessageFold("m1", { base });
    rest.forEach(fold.apply);
    await fold.parsePartialInputs();
    expect(stored(fold.snapshot())).toEqual(await sdk(rest, structuredClone(base)));
    expect(fold.snapshot().parts[0]).toMatchObject({ input: { command: "echo audit" } });
  });

  it(`clears ${dynamic ? "dynamic" : "static"} raw input once validated, retaining results and errors`, async () => {
    const base = await sdk(start);
    for (const terminal of [
      { type: "tool-output-available", toolCallId: "tool", output: { stdout: "audit" } },
      { type: "tool-output-error", toolCallId: "tool", errorText: "Cancelled" },
    ] as GramUIMessageChunk[]) {
      const rest: GramUIMessageChunk[] = [
        {
          type: "tool-input-available",
          toolCallId: "tool",
          toolName: "Bash",
          input: { command: "echo audit" },
          dynamic,
        },
        terminal,
      ];
      const fold = createMessageFold("m1", { base: structuredClone(base) });
      rest.forEach(fold.apply);
      expect(stored(fold.snapshot())).toEqual(await sdk(rest, structuredClone(base)));
      expect(fold.snapshot().parts[0]).not.toHaveProperty("rawInput");
      expect(fold.snapshot().parts[0]).toMatchObject({ input: { command: "echo audit" } });
    }
  });

  it(`keeps invalid ${dynamic ? "dynamic" : "static"} input and the provider error together`, async () => {
    const chunks: GramUIMessageChunk[] = [
      start[0]!,
      {
        type: "tool-input-error",
        toolCallId: "tool",
        toolName: "Bash",
        input: "{broken",
        errorText: "Invalid arguments",
        dynamic,
      },
    ];
    const fold = createMessageFold("m1");
    chunks.forEach(fold.apply);
    expect(stored(fold.snapshot())).toEqual(await sdk(chunks));
    expect(fold.snapshot().parts[0]).toMatchObject({
      input: "{broken",
      errorText: "Invalid arguments",
      state: "output-error",
    });
  });
}
