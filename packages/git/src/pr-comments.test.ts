import { describe, expect, it } from "vitest";
import { canWrite, parseFetchedComment, personCommentsQuery } from "./pr-comments.ts";

describe("personCommentsQuery", () => {
  it("names each node by a typed variable, never by its id", () => {
    const query = personCommentsQuery(2);
    expect(query.startsWith("query($i0:ID!,$i1:ID!){")).toBe(true);
    expect(query).toContain("c0:node(id:$i0)");
    expect(query).toContain("c1:node(id:$i1)");
    expect(query).toContain("viewerDidAuthor");
  });
});

describe("parseFetchedComment", () => {
  it("reads an issue comment", () => {
    expect(
      parseFetchedComment({
        __typename: "IssueComment",
        id: "IC_1",
        body: "Please rename it.",
        url: "https://github.com/acme/web/pull/12#issuecomment-1",
        createdAt: "2026-11-02T10:00:00Z",
        viewerDidAuthor: false,
        author: { login: "alice", __typename: "User" },
      }),
    ).toEqual({
      id: "IC_1",
      kind: "comment",
      author: "alice",
      authorIsBot: false,
      viewerDidAuthor: false,
      body: "Please rename it.",
      url: "https://github.com/acme/web/pull/12#issuecomment-1",
      createdAt: "2026-11-02T10:00:00Z",
      inline: [],
    });
  });

  it("reads a review with its inline comments, and a bot author as one", () => {
    const review = parseFetchedComment({
      __typename: "PullRequestReview",
      id: "PRR_1",
      state: "COMMENTED",
      body: "",
      url: "u",
      createdAt: "t",
      viewerDidAuthor: true,
      author: { login: "ci-helper", __typename: "Bot" },
      comments: {
        nodes: [{ id: "C1", body: "Here.", path: "a.ts", line: null, originalLine: 4, url: "u1" }],
      },
    });
    expect(review).toMatchObject({
      kind: "review",
      state: "COMMENTED",
      authorIsBot: true,
      viewerDidAuthor: true,
      inline: [{ id: "C1", path: "a.ts", line: 4, body: "Here." }],
    });
  });

  it("answers nothing for a node that is gone or of another type", () => {
    expect(parseFetchedComment(null)).toBeUndefined();
    expect(parseFetchedComment({ __typename: "Commit", id: "x" })).toBeUndefined();
  });
});

describe("canWrite", () => {
  it("lets the owner, admins and writers through, and nobody else", () => {
    expect(canWrite("admin")).toBe(true);
    expect(canWrite("write")).toBe(true);
    expect(canWrite("read")).toBe(false);
    expect(canWrite("none")).toBe(false);
  });
});
