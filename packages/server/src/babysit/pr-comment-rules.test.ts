import { describe, expect, it } from "vitest";
import type { FetchedComment } from "@gram/git";
import { commentProbe, isOwnComment, normaliseWords, passOver } from "./pr-comment-rules.ts";

const bots = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];

const comment = (body: string, extra: Partial<FetchedComment> = {}): FetchedComment => ({
  id: "IC_1",
  kind: "comment",
  author: "alice",
  authorIsBot: false,
  viewerDidAuthor: false,
  body,
  url: "",
  createdAt: "",
  inline: [],
  ...extra,
});

describe("passOver", () => {
  it("lets a person's comment with words through to the permission check", () => {
    expect(passOver(comment("Please rename it."), bots)).toBeUndefined();
  });

  it("passes over bots, verdicts, empty comments and Gram's own re-review command", () => {
    expect(passOver(comment("x", { authorIsBot: true }), bots)).toBe("bot");
    expect(passOver(comment("x", { author: "example-code-review" }), bots)).toBe("bot");
    expect(passOver(comment("x", { author: "renovate[bot]" }), bots)).toBe("bot");
    expect(passOver(comment("x", { author: "" }), bots)).toBe("bot");
    expect(passOver(comment("ok", { kind: "review", state: "APPROVED" }), bots)).toBe("verdict");
    expect(passOver(comment("  "), bots)).toBe("empty");
    expect(passOver(comment("/agent review", { viewerDidAuthor: true }), bots)).toBe("botCommand");
    expect(
      passOver(comment("/agent review\n\nFocus on the parser.", { viewerDidAuthor: true }), bots),
    ).toBe("botCommand");
    // From someone else, it's their word to the bot: still a person's comment.
    expect(passOver(comment("/agent review"), bots)).toBeUndefined();
  });
});

describe("isOwnComment", () => {
  it("finds a comment the thread posted through a shell command or a file it wrote", () => {
    const own = comment("Fixed in abc1234:\nthe empty list now returns early.");
    expect(
      isOwnComment(own, [
        "gh pr comment 12 --body 'Fixed in abc1234:\\nthe empty list now returns early.'",
      ]),
    ).toBe(true);
    expect(isOwnComment(own, ["Fixed in abc1234:\nthe empty list now returns early.\n"])).toBe(
      true,
    );
  });

  it("doesn't take the user's own words for the thread's, even when they quote it", () => {
    const reply = comment(
      "> Fixed in abc1234: the empty list now returns early.\n\nThanks, now please update the docs.",
    );
    expect(
      isOwnComment(reply, [
        "gh pr comment 12 --body 'Fixed in abc1234: the empty list now returns early.'",
      ]),
    ).toBe(false);
    expect(commentProbe(reply)).toBe(normaliseWords("Thanks, now please update the docs."));
  });

  it("counts a comment with no words of its own as nothing to act on", () => {
    expect(isOwnComment(comment("👍"), [])).toBe(true);
  });
});
