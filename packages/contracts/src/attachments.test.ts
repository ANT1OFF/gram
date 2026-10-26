import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AttachmentUpload } from "./attachments.ts";
import { GramRpcs } from "./rpc.ts";
import { expectRoundTrip } from "./test-utils.ts";

describe("attachment.upload", () => {
  it("round-trips an upload and returns an attachment with a path", () => {
    const upload = Schema.decodeUnknownSync(AttachmentUpload)({
      threadId: "t1",
      name: "image.png",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expectRoundTrip(AttachmentUpload, upload);

    const rpc = GramRpcs.requests.get("attachment.upload")!;
    const stored = {
      path: "/data/attachments/t1/1a2b3c4d-image.png",
      name: "image.png",
      mediaType: "image/png",
    };
    expect(
      Schema.decodeUnknownSync(rpc.successSchema as Schema.Codec<unknown, unknown>)(stored),
    ).toEqual(stored);
  });

  it("rejects an upload without a thread", () => {
    expect(() =>
      Schema.decodeUnknownSync(AttachmentUpload)({ name: "a.png", mediaType: "", data: "" }),
    ).toThrow();
  });
});
