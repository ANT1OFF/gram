import { describe, expect, it } from "vitest";
import { endWordOf, workerEndWord } from "./feature-card";

const pr = (state?: "open" | "merged" | "closed") => ({
  repo: "acme/widgets",
  number: 7,
  ...(state === undefined ? {} : { state }),
});

describe("a finished feature's word", () => {
  it("says merged only when a PR merged or the ledger says the worker merged", () => {
    expect(workerEndWord({ state: "merged", prs: [] })).toBe("merged");
    expect(workerEndWord({ state: "archived", prs: [pr("merged")] })).toBe("merged");
    expect(endWordOf({ workers: [{ state: "delivered", prs: [] }] } as never)).toBe("delivered");
  });

  it("says delivered for work archived with nothing merged", () => {
    expect(workerEndWord({ state: "archived", prs: [] })).toBe("delivered");
    expect(workerEndWord({ state: "archived", prs: [pr("closed")] })).toBe("delivered");
    expect(
      endWordOf({
        workers: [
          { state: "archived", prs: [] },
          { state: "merged", prs: [pr("merged")] },
        ],
      } as never),
    ).toBe("merged");
  });
});
