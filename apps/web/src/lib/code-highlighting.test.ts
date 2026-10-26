import type { BundledLanguage } from "shiki";
import { beforeEach, expect, it, vi } from "vitest";

const { createHighlighter, codeToTokens } = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
  codeToTokens: vi.fn(),
}));
vi.mock("shiki", () => ({ createHighlighter }));

beforeEach(() => {
  vi.resetModules();
  createHighlighter
    .mockReset()
    .mockResolvedValue({ codeToTokens, getLoadedLanguages: () => ["shellscript"] });
  codeToTokens.mockReset().mockImplementation((code: string) => ({
    tokens: code.split("\n").map((content) => [{ content, color: "#123456" }]),
  }));
});

it("does not substitute source with identical length, prefix and suffix", async () => {
  const { highlightCode } = await import("@/components/ai-elements/code-block");
  const first = "a".repeat(100) + "FIRST" + "z".repeat(100);
  const second = "a".repeat(100) + "OTHER" + "z".repeat(100);
  const loaded = await new Promise((resolve) => highlightCode(first, "shellscript", resolve));
  expect(loaded).toBeTruthy();
  const cached = highlightCode(second, "shellscript");
  const result =
    cached ?? (await new Promise((resolve) => highlightCode(second, "shellscript", resolve)));
  expect(JSON.stringify(result)).toContain("OTHER");
  expect(JSON.stringify(result)).not.toContain("FIRST");
});

it("deduplicates pending work, caches exact results and reuses the grammar", async () => {
  const { highlightCode } = await import("./code-highlighting");
  const a = new Promise((resolve) => highlightCode("echo one", "shellscript", resolve));
  const b = new Promise((resolve) => highlightCode("echo one", "shellscript", resolve));
  expect(await a).toBe(await b);
  expect(codeToTokens).toHaveBeenCalledTimes(1);
  expect(highlightCode("echo one", "shellscript")).toBe(await a);
  await new Promise((resolve) => highlightCode("echo two", "shellscript", resolve));
  expect(createHighlighter).toHaveBeenCalledTimes(1);
  expect(codeToTokens).toHaveBeenCalledTimes(2);
});

it.each(["x".repeat(16_385), "x".repeat(2_049), "\n".repeat(500)])(
  "keeps oversized input plain without loading a grammar",
  async (code) => {
    const { highlightCode } = await import("./code-highlighting");
    expect(highlightCode(code, "shellscript")).toBeNull();
    expect(createHighlighter).not.toHaveBeenCalled();
  },
);

it("bounds cached source and concurrent work", async () => {
  const { highlightCode } = await import("./code-highlighting");
  const requests = Array.from(
    { length: 64 },
    (_, index) => new Promise((resolve) => highlightCode(`echo ${index}`, "shellscript", resolve)),
  );
  expect(highlightCode("echo overloaded", "shellscript")).toBeNull();
  await Promise.all(requests);
  expect(codeToTokens).toHaveBeenCalledTimes(64);
  await new Promise((resolve) => highlightCode("echo new", "shellscript", resolve));
  expect(highlightCode("echo 0", "shellscript")).toBeNull();
});

it.each(["load", "grammar"])("falls back to exact text after a %s failure", async (kind) => {
  if (kind === "load")
    createHighlighter.mockRejectedValue(new Error("synthetic grammar load failure"));
  else
    codeToTokens.mockImplementation(() => {
      throw new Error("unsupported language");
    });
  const { highlightCode } = await import("./code-highlighting");
  const code = "\n<script> & 'quoted'\n\n";
  const result = await new Promise((resolve) =>
    highlightCode(code, "unsupported" as BundledLanguage, resolve),
  );
  expect(result).toEqual({
    bg: "transparent",
    fg: "inherit",
    tokens: [[], [{ color: "inherit", content: "<script> & 'quoted'", offset: 1 }], [], []],
  });
  expect(highlightCode(code, "unsupported" as BundledLanguage)).toBe(result);
});
