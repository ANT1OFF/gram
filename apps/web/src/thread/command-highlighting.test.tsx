// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as highlighting from "@/lib/code-highlighting";
import { HighlightedCode } from "@/components/ai-elements/code-block";
import type { AnyToolPart } from "./parts";
import { ToolCard } from "./tool-cards";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const command = `printf '%s\\n' '{"items":[1,2]}' | jq '\n  .items[] | select(. > 1)\n'\n\n`;
const props = {
  subagents: new Map(),
  subagentUsage: new Map(),
  streamingIds: new Set<string>(),
  renderSubagent: () => null,
};
const part = (dynamic: boolean, state = "output-available", overrides = {}) =>
  ({
    ...(dynamic ? { type: "dynamic-tool", toolName: "Bash" } : { type: "tool-Bash" }),
    toolCallId: "command",
    state,
    input: { command, ...(dynamic ? { cwd: "/synthetic" } : {}) },
    output: { stdout: '{"answer":2}\n', stderr: "synthetic warning\n", interrupted: true },
    providerExecuted: true,
    ...overrides,
  }) as unknown as AnyToolPart;

it.each([false, true])(
  "highlights the %s dynamic command only after expansion and preserves output",
  async (dynamic) => {
    const { container } = render(<ToolCard part={part(dynamic)} {...props} />);
    expect(container.querySelector("code")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    const code = container.querySelector("code")!;
    await waitFor(() => expect(code.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
    expect(code.textContent).toBe(command);
    expect(code.closest("pre")!.textContent).toBe(`$ ${command}`);
    if (dynamic) {
      expect(container.querySelectorAll("pre")[1]!.textContent).toBe('{\n  "cwd": "/synthetic"\n}');
      expect(container.querySelectorAll("pre")[2]!.textContent).toBe(
        JSON.stringify((part(true) as { output: unknown }).output, null, 2),
      );
    } else {
      expect(container.querySelectorAll("pre")[1]!.textContent).toBe(
        '{"answer":2}\nsynthetic warning\n',
      );
      expect(container.querySelector(".text-destructive")!.textContent).toBe("synthetic warning\n");
      expect(screen.getByText("Interrupted")).toBeTruthy();
    }
  },
);

it("keeps sidechain result strings plain and preserves cancellation and errors", async () => {
  const { container, rerender } = render(
    <ToolCard
      part={part(false, "output-available", { output: "opaque <tag> & stdout" })}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(container.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
  expect(container.querySelectorAll("pre")[1]!.textContent).toBe("opaque <tag> & stdout");
  expect(container.querySelector("tag")).toBeNull();
  rerender(<ToolCard part={part(true, "output-error", { errorText: "Cancelled" })} {...props} />);
  expect(screen.getByRole("button").textContent).toContain("Cancelled");
  fireEvent.click(screen.getByRole("button"));
  expect(container.querySelectorAll("pre")[2]!.textContent).toBe("Cancelled");
});

it("keeps partial streaming input plain, then colors the completed command", async () => {
  const { container, rerender } = render(
    <ToolCard part={part(false, "input-streaming")} {...props} />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(container.querySelector("code")!.textContent).toBe(command);
  expect(container.querySelector('[style*="--shiki-dark"]')).toBeNull();
  rerender(<ToolCard part={part(false, "input-available")} {...props} />);
  await waitFor(() => expect(container.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
  expect(screen.getByRole("button").textContent).toContain("Running");
});

it("renders exact safe text for large commands and unsupported grammars", async () => {
  const code = '<script>alert("synthetic")</script>\n' + "x".repeat(16_385) + "\n\n";
  const { container, rerender } = render(<HighlightedCode code={code} language="shellscript" />);
  expect(container.textContent).toBe(code);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector('[style*="--shiki-dark"]')).toBeNull();
  rerender(<HighlightedCode code={"\n<tag> &\n\n"} language={"unsupported" as "shellscript"} />);
  await waitFor(() => expect(container.textContent).toBe("\n<tag> &\n\n"));
  expect(container.querySelector("tag")).toBeNull();
});

const exactCommands = [
  ["CRLF", "printf hello\r\necho there\r\n\r\n"],
  ["mixed separators", "printf hello\r\necho there\nprintf done\r\n\n"],
  ["lone CR", "printf 'hello\rthere'\r"],
  ["quoted multiline argument", "printf '%s\\n' 'first\r\nsecond\nthird'\t| cat\r\n\r\n"],
  ["tabs and Unicode", "printf 'α\t🌈'\r\necho '汉字'\n\n"],
] as const;

for (const dynamic of [false, true]) {
  it.each(exactCommands)(
    `preserves exact %s source and DOM Range after real Shiki coloring (dynamic ${dynamic})`,
    async (_name, source) => {
      const { container } = render(
        <ToolCard
          part={part(dynamic, "output-available", {
            input: { command: source, ...(dynamic ? { cwd: "/synthetic" } : {}) },
          })}
          {...props}
        />,
      );
      fireEvent.click(screen.getByRole("button"));
      const code = container.querySelector("code")!;
      expect(code.textContent).toBe(source);
      await waitFor(() => expect(code.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
      expect(code.textContent).toBe(source);
      const range = document.createRange();
      range.selectNodeContents(code);
      expect(range.toString()).toBe(source);
      expect(code.closest("pre")!.textContent).toBe(`$ ${source}`);
    },
  );
}

it("falls back to exact source if grammar tokens cannot reproduce it", async () => {
  const altered = highlighting.createRawTokens("echo altered");
  const mock = vi.spyOn(highlighting, "highlightCode").mockReturnValue(altered);
  const source = "echo original\r\n\n";
  const { container } = render(<HighlightedCode code={source} language="shellscript" />);
  await waitFor(() => expect(mock).toHaveBeenCalled());
  expect(container.textContent).toBe(source);
  const range = document.createRange();
  range.selectNodeContents(container.querySelector("code")!);
  expect(range.toString()).toBe(source);
  expect(container.textContent).not.toContain("altered");
});
