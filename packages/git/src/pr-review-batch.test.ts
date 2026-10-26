import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GetPrStatus, makePrResolver, prGraphqlQuery, type PrInputs } from "./pr.ts";
import type { ProcShape } from "./proc.ts";

const node = JSON.parse(
  readFileSync(new URL("./fixtures/review-bot/changes-requested.json", import.meta.url), "utf8"),
).data.repository.pullRequest;

const inputs: PrInputs = {
  workTree: "/tmp",
  branch: node.headRefName,
  localTip: node.headRefOid,
  remoteTip: "",
  repo: "acme/web",
};

describe("batched PR lookups carry review-bot state", () => {
  it("query the review fields in the batch document", () => {
    const query = prGraphqlQuery([
      { kind: "pr", fields: "reviewAndThreads" },
      { kind: "pr", fields: "review" },
    ]);
    expect(query.split("reviews(last:20)")).toHaveLength(3);
    expect(query.split("reviewThreads(first:50)")).toHaveLength(2);
    expect(query.split("{").length).toBe(query.split("}").length);
  });

  it.effect("compute pr.review from the reshaped node, with configurable bots", () =>
    Effect.gen(function* () {
      const proc: ProcShape = {
        run: (bin) =>
          Effect.succeed(
            bin === "gh"
              ? {
                  status: 0,
                  stdout: JSON.stringify({
                    // The candidates' block and the chosen PR's both read alias `e0`.
                    data: {
                      e0: {
                        pullRequests: { nodes: [{ ...node, state: "OPEN" }] },
                        pullRequest: { ...node, state: "OPEN" },
                      },
                    },
                  }),
                  stderr: "",
                  truncated: false,
                }
              : { status: 1, stdout: "", stderr: "", truncated: false },
          ),
      };
      const badge = yield* Effect.request(
        GetPrStatus({ lookup: { kind: "branch", inputs } }),
        makePrResolver(
          proc,
          Effect.succeed([
            {
              loginPattern: "example-code-review[bot]",
              rereviewCommand: "/agent review",
              canApprove: true,
            },
          ]),
        ),
      );
      expect(badge?.review).toMatchObject({
        verdictOnHead: "changesRequested",
        reviewedHead: true,
        threads: { blockers: 2, suggestions: 4 },
      });

      const noBots = makePrResolver(
        proc,
        Effect.succeed([
          { loginPattern: "someone-else[bot]", rereviewCommand: "/review", canApprove: false },
        ]),
      );
      const plain = yield* Effect.request(
        GetPrStatus({ lookup: { kind: "branch", inputs } }),
        noBots,
      );
      expect(plain?.number).toBe(node.number);
      // The unconfigured bot's threads carry no `__typename` in this fixture, so they count as people's.
      expect(plain?.review).toMatchObject({ bots: [], reviewedHead: false });
      expect(plain?.review?.verdictOnHead).toBeUndefined();
      expect(plain?.review?.threads).toMatchObject({ unresolved: 0, blockers: 0, suggestions: 0 });
    }),
  );
});
