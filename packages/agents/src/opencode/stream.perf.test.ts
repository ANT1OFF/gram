import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent, MessageId } from "@gram/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { makeOpenCodeClient } from "./client.ts";
import { makeOpenCodeMapper } from "./mapper.ts";
import type { OpenCodeEvent } from "./protocol.ts";

// What an OpenCode thread costs the server between `opencode serve`'s event stream and Gram's
// events: the client's SSE reader and the mapper, on a synthetic session shaped like the recorded
// fixtures. Long replies arrive as many small deltas, tool calls carry a file's content as input,
// and a session runs many turns. Opt in with GRAM_PERF_OPENCODE=1; `GRAM_PERF_OUT` names the JSON
// results file, which `tools/perf/headline-chart.mjs` compares. `GRAM_PERF_OPENCODE_TURNS` sets the
// turns in the long session.
const PERF = process.env["GRAM_PERF_OPENCODE"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-opencode.json");
const TURNS = Number(process.env["GRAM_PERF_OPENCODE_TURNS"] ?? 400);
const REPEATS = Number(process.env["GRAM_PERF_REPEATS"] ?? 5);
/** What one read of the response body hands the reader: Node's fetch reads about this much. */
const CHUNK_BYTES = 16 * 1024;

const SESSION = "ses_perf";
interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly unit: "ms" | "bytes";
  readonly value: number;
  readonly samples: readonly number[];
  readonly detail?: Readonly<Record<string, number | string>>;
}
const scenarios: Scenario[] = [];
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (n: number, digits = 2) => Number(n.toFixed(digits));

let seq = 0;
const event = (type: string, data: Record<string, unknown>) =>
  JSON.stringify({
    id: `evt_${(seq += 1)}`,
    created: 1_794_695_777_795 + seq,
    type,
    location: { directory: "/work/project" },
    data: { sessionID: SESSION, ...data },
    durable: { aggregateID: SESSION, seq, version: 1 },
  });

const fileContent = (kilobytes: number, salt: number) =>
  Array.from(
    { length: Math.ceil((kilobytes * 1024) / 64) },
    (_, line) => `export const value${salt}_${line} = ${line}; // generated line ${line}\n`,
  ).join("");

/**
 * One turn as `opencode serve` streams it: a step that writes `tools` files of `fileKilobytes`
 * each, then a step whose reply is `words` words in four-word deltas.
 */
const turnEvents = (
  turn: number,
  opts: { words: number; tools: number; fileKilobytes: number },
) => {
  const out: string[] = [];
  const first = `msg_${turn}_a`;
  const second = `msg_${turn}_b`;
  const tokens = { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } };
  out.push(event("session.execution.started", {}));
  out.push(event("session.step.started", { assistantMessageID: first, agent: "build" }));
  for (let tool = 0; tool < opts.tools; tool += 1) {
    const id = `call_${turn}_${tool}`;
    out.push(event("session.tool.input.started", { assistantMessageID: first, id, name: "write" }));
    out.push(
      event("session.tool.called", {
        assistantMessageID: first,
        id,
        input: { path: `src/file${tool}.ts`, content: fileContent(opts.fileKilobytes, tool) },
        executed: false,
      }),
    );
    out.push(
      event("session.tool.success", {
        assistantMessageID: first,
        id,
        content: [{ type: "text", text: "Wrote the file" }],
        metadata: { status: "completed" },
      }),
    );
  }
  out.push(
    event("session.step.ended", { assistantMessageID: first, finish: "tool-calls", tokens }),
  );
  out.push(event("session.step.started", { assistantMessageID: second, agent: "build" }));
  out.push(event("session.text.started", { assistantMessageID: second, ordinal: 0 }));
  const words = Array.from({ length: opts.words }, (_, index) => `word${index % 97}`);
  for (let at = 0; at < words.length; at += 4)
    out.push(
      event("session.text.delta", {
        assistantMessageID: second,
        ordinal: 0,
        delta: `${words.slice(at, at + 4).join(" ")} `,
      }),
    );
  out.push(event("session.text.ended", { assistantMessageID: second, ordinal: 0 }));
  out.push(event("session.step.ended", { assistantMessageID: second, finish: "stop", tokens }));
  out.push(event("session.usage.updated", { tokens, cost: 0 }));
  out.push(event("session.execution.succeeded", {}));
  return out;
};

const sse = (events: readonly string[]) => events.map((data) => `data: ${data}\n\n`).join("");
/** One turn of the long session: a short reply after three 16 kB files. */
const turn = (index: number) => sse(turnEvents(index, { words: 40, tools: 3, fileKilobytes: 16 }));

/** `text` as a response body that hands it over in `CHUNK_BYTES` reads. */
const bodyOf = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + CHUNK_BYTES));
      at += CHUNK_BYTES;
    },
  });
};

/** Reads `text` through the real client and mapper; how long, the slowest read, and what came out. */
const readThrough = async (text: string) => {
  let n = 0;
  const mapper = makeOpenCodeMapper({
    sessionId: SESSION,
    newMessageId: () => `m${(n += 1)}` as MessageId,
  });
  const client = makeOpenCodeClient({
    baseUrl: "http://127.0.0.1:1",
    password: "perf",
    fetch: async () => new Response(bodyOf(text), { status: 200 }),
  });
  let events = 0;
  let out = 0;
  const started = performance.now();
  await client.subscribe((received: OpenCodeEvent) => {
    events += 1;
    out += mapper.map(received).length;
  }, new AbortController().signal);
  return { ms: performance.now() - started, events, out, mapper };
};

const heapAfterGc = () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
};

describe.skipIf(!PERF)("an OpenCode session through the client and the mapper", () => {
  afterAll(() => {
    writeFileSync(OUT_FILE, `${JSON.stringify({ scenarios }, null, 2)}\n`);
    console.log(`wrote ${OUT_FILE}`);
  });

  it("reads a 2,000-word reply streamed in four-word deltas", async () => {
    const text = sse(turnEvents(0, { words: 2_000, tools: 0, fileKilobytes: 0 }));
    const samples: number[] = [];
    let last = { events: 0, out: 0 };
    for (let index = 0; index <= REPEATS; index += 1) {
      const run = await readThrough(text);
      if (index > 0) samples.push(round(run.ms));
      last = run;
    }
    expect(last.events).toBeGreaterThan(500);
    const value = round(median(samples));
    scenarios.push({
      id: "opencode-stream-reply",
      label: "Read and map a 2,000-word OpenCode reply",
      unit: "ms",
      value,
      samples,
      detail: {
        events: last.events,
        agentEvents: last.out,
        microsecondsPerEvent: round((value * 1000) / last.events, 1),
        kilobytes: round(text.length / 1024, 1),
      },
    });
    console.log(`2,000-word reply: ${value} ms for ${last.events} events`);
  }, 120_000);

  it("reads a turn that writes 40 files of 64 kB", async () => {
    const text = sse(turnEvents(0, { words: 200, tools: 40, fileKilobytes: 64 }));
    const samples: number[] = [];
    let last = { events: 0, out: 0 };
    for (let index = 0; index <= REPEATS; index += 1) {
      const run = await readThrough(text);
      if (index > 0) samples.push(round(run.ms));
      last = run;
    }
    const value = round(median(samples));
    scenarios.push({
      id: "opencode-stream-tools",
      label: "Read and map a turn writing 40 files of 64 kB",
      unit: "ms",
      value,
      samples,
      detail: { events: last.events, megabytes: round(text.length / 1024 / 1024) },
    });
    console.log(`40 writes of 64 kB: ${value} ms, ${round(text.length / 1024 / 1024)} MB`);
  }, 120_000);

  it(`holds what a ${TURNS}-turn session needs, not every tool call it made`, async () => {
    let n = 0;
    const mapper = makeOpenCodeMapper({
      sessionId: SESSION,
      newMessageId: () => `m${(n += 1)}` as MessageId,
    });
    const feed = async (from: number, to: number) => {
      const client = makeOpenCodeClient({
        baseUrl: "http://127.0.0.1:1",
        password: "perf",
        fetch: async () =>
          new Response(
            bodyOf(Array.from({ length: to - from }, (_, index) => turn(from + index)).join("")),
            { status: 200 },
          ),
      });
      const ends: AgentEvent[] = [];
      await client.subscribe((received) => {
        for (const out of mapper.map(received)) if (out.type === "turnEnd") ends.push(out);
      }, new AbortController().signal);
      return ends.length;
    };
    const warm = Math.max(1, Math.round(TURNS / 10));
    await feed(0, warm);
    const before = heapAfterGc();
    const ended = await feed(warm, TURNS);
    const after = heapAfterGc();
    expect(ended).toBe(TURNS - warm);
    const retained = Math.max(0, after - before);
    const written = (TURNS - warm) * 3 * 16 * 1024;
    scenarios.push({
      id: "opencode-session-retained",
      label: `Heap a ${TURNS}-turn OpenCode session keeps after its turns end`,
      unit: "bytes",
      value: retained,
      samples: [retained],
      detail: {
        turns: TURNS - warm,
        toolCalls: (TURNS - warm) * 3,
        writtenMegabytes: round(written / 1024 / 1024, 1),
        gc: typeof (globalThis as { gc?: unknown }).gc === "function" ? "forced" : "not exposed",
      },
    });
    console.log(
      `${TURNS - warm} turns: heap kept ${round(retained / 1024 / 1024)} MB of ${round(written / 1024 / 1024)} MB written`,
    );
  }, 300_000);
});
