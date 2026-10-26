// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeBlock, CodeBlockCopyButton, CodeBlockContent } from "./code-block";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps the existing copy action exact, including trailing blank lines, after highlighting", async () => {
  const source = 'const quoted = "<script> & text";\n\n';
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const { container } = render(
    <CodeBlock code={source} language="typescript" showLineNumbers>
      <CodeBlockCopyButton aria-label="Copy code" />
    </CodeBlock>,
  );
  await waitFor(() => expect(container.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
  expect(container.querySelectorAll("[data-line]")).toHaveLength(3);
  expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(source));
});

it("uses new source after a cached render and retains highlighted line ranges", async () => {
  const { container, rerender } = render(
    <CodeBlockContent code={"echo one\necho two"} language="shellscript" highlightLine={2} />,
  );
  await waitFor(() => expect(container.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
  rerender(
    <CodeBlockContent
      code={"echo newest\necho last"}
      language="shellscript"
      highlightLine={1}
      highlightEnd={2}
    />,
  );
  expect(container.querySelector('[data-line="1"]')!.textContent).toBe("echo newest");
  expect(container.querySelector('[data-line="2"]')!.textContent).toBe("echo last");
  await waitFor(() => expect(container.querySelector('[style*="--shiki-dark"]')).toBeTruthy());
  expect(container.querySelectorAll("[data-highlighted]")).toHaveLength(2);
  expect(container.querySelector("pre")!.textContent).not.toContain("one");
});
