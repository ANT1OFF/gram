// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as highlighting from "@/lib/code-highlighting";
import { createMessageFold } from "@/stores/message-fold";
import { isJsonOutput } from "./json-text";
import type { AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const props = {
  subagents: new Map(),
  subagentUsage: new Map(),
  streamingIds: new Set<string>(),
  renderSubagent: () => null,
};
const raw =
  ' \t{\r\n\t"nested": [true, null, {"html": "<script>α🌈</script>", "escaped": "\\t\\n"}]\n} \r\n\n';
const makePart = (dynamic: boolean, overrides = {}) =>
  ({
    ...(dynamic ? { type: "dynamic-tool", toolName: "Bash" } : { type: "tool-Bash" }),
    toolCallId: "json",
    state: "output-available",
    input: {
      command: "echo synthetic",
      ...(dynamic ? { cwd: "/synthetic", options: { nested: [true, null] } } : {}),
    },
    output: dynamic ? raw : { stdout: raw, stderr: '{"error":"synthetic"}\n', interrupted: true },
    ...overrides,
  }) as AnyToolPart;

it.each([false, true])(
  "colors final JSON for dynamic %s with exact source and diagnostic emphasis",
  async (dynamic) => {
    const { container } = render(<ToolCard part={makePart(dynamic)} {...props} />);
    expect(container.querySelector("code")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    const code = container.querySelectorAll('code[data-language="json"]');
    const output = code[code.length - 1]!;
    await waitFor(() => expect(output.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
    expect(output.textContent).toBe(raw);
    const range = document.createRange();
    range.selectNodeContents(output);
    expect(range.toString()).toBe(raw);
    expect(container.querySelector("script")).toBeNull();
    if (!dynamic) {
      const stderr = container.querySelector(".text-destructive")!;
      expect(stderr.textContent).toBe('{"error":"synthetic"}\n');
      expect(stderr.querySelector("code")).toBeNull();
      expect(screen.getByText("Interrupted")).toBeTruthy();
    }
  },
);

it("colors known nested structured generic input/output using the existing serialization", async () => {
  const input = { nested: [null, true, { quoted: '"α\t\n<em>🌈</em>' }] };
  const output = { nested: { answer: 42 } };
  const { container } = render(
    <ToolCard part={makePart(true, { toolName: "synthetic_json", input, output })} {...props} />,
  );
  fireEvent.click(screen.getByRole("button"));
  const codes = container.querySelectorAll('code[data-language="json"]');
  expect(codes).toHaveLength(2);
  await waitFor(() =>
    expect([...codes].every((code) => code.querySelector('[style*="--shiki-dark"]'))).toBe(true),
  );
  expect(codes[0]!.textContent).toBe(JSON.stringify(input, null, 2));
  expect(codes[1]!.textContent).toBe(JSON.stringify(output, null, 2));
  expect(container.querySelector("em")).toBeNull();
});

it.each([false, true])(
  "keeps streaming output and input plain then reuses unchanged tokens (dynamic %s)",
  async (dynamic) => {
    const spy = vi.spyOn(highlighting, "highlightCode");
    const { container, rerender } = render(
      <ToolCard part={makePart(dynamic, { state: "input-streaming" })} {...props} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(spy).not.toHaveBeenCalled();
    rerender(<ToolCard part={makePart(dynamic, { preliminary: true })} {...props} />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.querySelectorAll('code[data-language="json"]')).toHaveLength(dynamic ? 1 : 0);
    // Preliminary output does not even run JSON.parse.
    const parse = vi.spyOn(JSON, "parse");
    rerender(
      <ToolCard
        part={makePart(dynamic, {
          preliminary: true,
          output: dynamic
            ? '{"partial":'
            : { stdout: '{"partial":', stderr: "", interrupted: false },
        })}
        {...props}
      />,
    );
    expect(parse).not.toHaveBeenCalled();
    rerender(<ToolCard part={makePart(dynamic)} {...props} />);
    await waitFor(() =>
      expect(
        container.querySelector('code[data-language="json"] [style*="--shiki-dark"]'),
      ).toBeTruthy(),
    );
    const shellCalls = spy.mock.calls.filter(([, lang]) => lang === "shellscript").length;
    const parseCalls = parse.mock.calls.length;
    rerender(<ToolCard part={makePart(dynamic)} {...props} />);
    expect(spy.mock.calls.filter(([, lang]) => lang === "shellscript")).toHaveLength(shellCalls);
    expect(parse).toHaveBeenCalledTimes(parseCalls);
  },
);

it.each([
  '{"partial":',
  "{bad}",
  'log {"a":1}',
  "1",
  "true",
  '"text"',
  "{}\n{}",
  "[1]\nextra",
  `{"x":"${"x".repeat(2049)}"}`,
  `[${"\n".repeat(500)}]`,
  `[${" ".repeat(16385)}]`,
])("refuses unsupported whole output %s before grammar work", (text) => {
  const spy = vi.spyOn(highlighting, "highlightCode");
  const { container } = render(<ToolCard part={makePart(false, { output: text })} {...props} />);
  fireEvent.click(screen.getByRole("button"));
  expect(container.querySelectorAll("pre")[1]!.textContent).toBe(text);
  expect(container.querySelector('code[data-language="json"]')).toBeNull();
  expect(spy.mock.calls.every(([, lang]) => lang === "shellscript")).toBe(true);
});

it("bounds classification before parsing and accepts arrays/objects only", () => {
  const parse = vi.spyOn(JSON, "parse");
  expect(isJsonOutput(`[${" ".repeat(16385)}]`)).toBe(false);
  expect(isJsonOutput(`[${"\n".repeat(500)}]`)).toBe(false);
  expect(isJsonOutput(`{"x":"${"x".repeat(2049)}"}`)).toBe(false);
  expect(parse).not.toHaveBeenCalled();
  expect(isJsonOutput(" [1, true, null] \n")).toBe(true);
  expect(isJsonOutput(" {} \r\n")).toBe(true);
});

it.each([
  ["total length", Array.from({ length: 5000 }, (_, i) => i)],
  ["line length", { long: "x".repeat(2049) }],
  ["line count", Array.from({ length: 499 }, (_, i) => i)],
])("keeps over-limit serialized %s input/output as exact plain text nodes", (_label, value) => {
  const source = JSON.stringify(value, null, 2);
  const parse = vi.spyOn(JSON, "parse");
  const highlight = vi.spyOn(highlighting, "highlightCode");
  const { container } = render(
    <ToolCard
      part={makePart(true, { toolName: "synthetic_large_json", input: value, output: value })}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  for (const pre of container.querySelectorAll("pre")) {
    expect(pre.textContent).toBe(source);
    expect(pre.querySelectorAll("*")).toHaveLength(0);
    const range = document.createRange();
    range.selectNodeContents(pre);
    expect(range.toString()).toBe(source);
  }
  expect(parse).not.toHaveBeenCalled();
  expect(highlight).not.toHaveBeenCalled();
});

it("keeps oversized remaining command metadata plain without changing the shell", async () => {
  const value = Array.from({ length: 5000 }, (_, i) => i);
  const { container } = render(
    <ToolCard
      part={makePart(true, {
        input: { command: "echo synthetic", options: value },
        output: "ordinary log",
      })}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  const metadata = container.querySelectorAll("pre")[1]!;
  expect(metadata.textContent).toBe(JSON.stringify({ options: value }, null, 2));
  expect(metadata.querySelectorAll("*")).toHaveLength(0);
  await waitFor(() =>
    expect(
      container.querySelector('code[data-language="shellscript"] [style*="--shiki-dark"]'),
    ).toBeTruthy(),
  );
});

it.each([false, true])(
  "preserves JSON through persisted fold and output-only updates (dynamic %s)",
  async (dynamic) => {
    const fold = createMessageFold("json-fold");
    fold.apply({
      type: "tool-input-available",
      toolCallId: "json",
      toolName: "Bash",
      input: { command: "echo synthetic", cwd: "/synthetic" },
      dynamic,
    });
    fold.apply({
      type: "tool-output-available",
      toolCallId: "json",
      output: dynamic ? raw : { stdout: raw, stderr: "", interrupted: false },
      dynamic,
    });
    const part = JSON.parse(JSON.stringify(fold.snapshot().parts[0])) as AnyToolPart;
    const spy = vi.spyOn(highlighting, "highlightCode");
    const { container, rerender } = render(<ToolCard part={part} {...props} />);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(
        container.querySelector('code[data-language="json"] [style*="--shiki-dark"]'),
      ).toBeTruthy(),
    );
    const retained = spy.mock.calls.filter(([code]) => code !== raw).length;
    const next = ' [true, {"answer":42}] \r\n';
    rerender(
      <ToolCard
        part={
          {
            ...part,
            output: dynamic ? next : { stdout: next, stderr: "", interrupted: false },
          } as AnyToolPart
        }
        {...props}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll("pre")[dynamic ? 2 : 1]!.textContent).toBe(next),
    );
    expect(spy.mock.calls.filter(([code]) => code !== raw && code !== next)).toHaveLength(retained);
  },
);
