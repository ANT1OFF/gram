import { describe, expect, it } from "vitest";

import { publishedArtifacts } from "./published-artifacts";

const published = (input: unknown, output: unknown) => ({
  type: "tool-Artifact",
  state: "output-available",
  input,
  output,
});

describe("publishedArtifacts", () => {
  it("lists each claude.ai page a message's finished publishes left, last published last", () => {
    const first = "https://claude.ai/code/artifact/11111111-1111-4111-8111-111111111111";
    const second = "https://claude.ai/code/artifact/22222222-2222-4222-8222-222222222222";
    expect(
      publishedArtifacts([
        published(
          { file_path: "/tmp/scratch/checkout-mock.html" },
          { url: first, path: "/tmp/scratch/checkout-mock.html", title: "Checkout", version: "1" },
        ),
        published({ action: "list" }, { artifacts: [{ title: "Old", url: second }] }),
        published({ file_path: "/tmp/scratch/notes.txt" }, { url: second, path: "/tmp/notes.txt" }),
        {
          type: "tool-Artifact",
          state: "output-error",
          input: { file_path: "/tmp/failed.html" },
        },
        published({ file_path: "/tmp/scratch/phish.html" }, { url: "https://claude.ai.evil/x" }),
        published({ file_path: "/tmp/scratch/plain.html" }, { url: "http://claude.ai/x" }),
        published(
          { file_path: "/tmp/scratch/checkout-mock.html" },
          { url: first, title: "Checkout", version: "2" },
        ),
        { type: "tool-Write", state: "output-available", input: { file_path: "/tmp/a.html" } },
      ]),
    ).toEqual([
      { url: second },
      {
        url: first,
        title: "Checkout",
        version: "2",
        source: { path: "/tmp/scratch/checkout-mock.html", kind: "html" },
      },
    ]);
  });

  it("falls back to the path Claude Code reports, and never offers a credential file", () => {
    const url = "https://claude.ai/artifact/abc";
    expect(publishedArtifacts([published({}, { url, path: "/tmp/scratch/board.md" })])).toEqual([
      { url, source: { path: "/tmp/scratch/board.md", kind: "markdown" } },
    ]);
    expect(
      publishedArtifacts([published({ file_path: "/Users/me/.aws/page.html" }, { url })]),
    ).toEqual([{ url }]);
  });
});
