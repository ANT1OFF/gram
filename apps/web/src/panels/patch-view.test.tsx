// @vitest-environment happy-dom
import type { DiffFile } from "@gram/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { PatchView } from "./patch-view";

afterEach(cleanup);

const written = (lines: readonly string[]): DiffFile => ({
  path: "src/rate-limit.ts",
  status: "added",
  additions: lines.length,
  deletions: 0,
  patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`,
  binary: false,
  tooLarge: false,
});

const colored = (row: Element | null) =>
  row !== null && row.querySelector('[style*="--shiki-dark"]') !== null;

it("a file streaming in keeps its rows and their colours as each chunk grows the hunk", async () => {
  const first = ['import { sleep } from "./clock";', "export const limit = 10;"];
  const { container, rerender } = render(
    <PatchView file={written(first)} language="typescript" headers={false} />,
  );
  await waitFor(() => expect(colored(container.querySelector('[data-line="0:0"]'))).toBe(true));
  const body = container.querySelector("tbody");

  // The next chunk: the hunk's header counts one more line, before its highlighting is in.
  rerender(
    <PatchView
      file={written([...first, "export const windowMs = 250;"])}
      language="typescript"
      headers={false}
    />,
  );
  expect(container.querySelector("tbody")).toBe(body);
  expect(colored(container.querySelector('[data-line="0:0"]'))).toBe(true);
  expect(colored(container.querySelector('[data-line="0:1"]'))).toBe(true);
  expect(container.querySelector('[data-line="0:2"]')!.textContent).toContain(
    "export const windowMs = 250;",
  );
  await waitFor(() => expect(colored(container.querySelector('[data-line="0:2"]'))).toBe(true));
});
