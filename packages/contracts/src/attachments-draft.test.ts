import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AttachmentUpload } from "./attachments.ts";
import { GramRpcs } from "./rpc.ts";
import { expectRoundTrip } from "./test-utils.ts";

const DRAFT = "5a9b6bc9-01d5-4fb3-aacf-ec410b8b74d5";
const file = { name: "image.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
const decode = Schema.decodeUnknownSync(AttachmentUpload);

describe("draft attachment uploads", () => {
  it("stages an upload for a draft", () => {
    expectRoundTrip(AttachmentUpload, decode({ draftId: DRAFT, ...file }));
  });

  it("needs exactly one of threadId and draftId", () => {
    expect(() => decode(file)).toThrow();
    expect(() => decode({ threadId: "t1", draftId: DRAFT, ...file })).toThrow();
  });

  it("rejects a draft id that isn't a safe folder name", () => {
    for (const draftId of ["../../etc", "short", "a/b-c-d-e-f-g", "x".repeat(65)]) {
      expect(() => decode({ draftId, ...file }), draftId).toThrow();
    }
  });

  it("carries the draft id on thread.create", () => {
    const rpc = GramRpcs.requests.get("thread.create")!;
    expect(
      Schema.decodeUnknownSync(rpc.payloadSchema as Schema.Codec<unknown, unknown>)({
        projectRoot: "/work/repo",
        checkout: { kind: "current" },
        input: {
          text: "look",
          attachments: [{ path: `/data/attachments/_drafts/${DRAFT}/1a2b3c4d-image.png` }],
        },
        draftId: DRAFT,
      }),
    ).toMatchObject({ draftId: DRAFT });
  });
});
