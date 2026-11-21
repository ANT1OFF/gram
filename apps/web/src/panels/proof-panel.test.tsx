// @vitest-environment happy-dom
import type { FileImage, ThreadId, VerifyState } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";

import { ProofPanel } from "./proof-panel";

const T = "t-worker" as ThreadId;
const HEAD = "a".repeat(40);

const state: VerifyState = {
  recipe: "ok",
  head: HEAD,
  drivers: [
    {
      name: "flows",
      run: "bun run drive --all",
      status: "passed",
      startedAt: 1,
      finishedAt: 2,
      evidence: [
        { file: "start.png", kind: "screenshot", caption: "The first step", size: 3 },
        { file: "tour.webm", kind: "video", caption: "The whole tour", size: 9 },
      ],
    },
  ],
};

afterEach(cleanup);

describe("a worker's Proof", () => {
  it("shows a driver's screenshots from Gram, and names what isn't a picture", async () => {
    const verifyEvidence = vi.fn(
      async (_thread: ThreadId, _driver: string, file: string): Promise<FileImage> => ({
        path: file,
        mediaType: "image/png",
        size: 3,
        tooLarge: false,
        base64: "cG5n",
      }),
    );
    const api = { verifyState: async () => state, verifyEvidence } as unknown as Api;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ApiProvider api={api}>
        <QueryClientProvider client={client}>
          <ProofPanel threadId={T} head={HEAD} />
        </QueryClientProvider>
      </ApiProvider>,
    );
    const picture = await screen.findByRole("img", { name: "start.png" });
    expect(picture.getAttribute("src")).toBe("data:image/png;base64,cG5n");
    expect(verifyEvidence.mock.calls).toEqual([[T, "flows", "start.png"]]);
    const items = screen.getAllByTestId("proof-evidence");
    expect(within(items[1]!).getByText("tour.webm")).toBeTruthy();
  });
});
