import { describe, expect, it } from "@effect/vitest";
import { ThreadNotFound, type GramUIMessage, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { pathToFileURL } from "node:url";
import {
  attachUserWords,
  BRIEF_FOOTER_LINE,
  USER_WORDS_MAX,
  userMessagesOf,
  withBriefFooter,
  withUserWords,
} from "./user-words.ts";

const message = (
  id: string,
  role: "user" | "assistant",
  parts: ReadonlyArray<Record<string, unknown>>,
  author?: "user" | "server",
): GramUIMessage =>
  ({
    id,
    role,
    parts,
    ...(author === undefined ? {} : { metadata: { author } }),
  }) as unknown as GramUIMessage;

const typed = (id: string, text: string) => message(id, "user", [{ type: "text", text }], "user");

const transcript: ReadonlyArray<GramUIMessage> = [
  typed("u1", "Set up the repo."),
  message("d1", "user", [
    { type: "text", text: "Orchestration digest #3" },
    { type: "data-orchestration-digest", id: "d1", data: {} },
  ]),
  message("a1", "assistant", [{ type: "text", text: "Starting a worker." }]),
  message("w1", "user", [
    { type: "text", text: "Done: PR acme/web#12" },
    { type: "data-thread-origin", id: "w1", data: { threadId: "t2" } },
  ]),
  message(
    "u2",
    "user",
    [
      { type: "text", text: "Here is the log:\n  at foo (bar.ts:1)" },
      { type: "file", mediaType: "text/plain", url: pathToFileURL("/tmp/a/log.txt").href },
      { type: "data-wait-note", id: "u2", data: { text: "Nothing waits on you." } },
    ],
    "user",
  ),
  // Gram's notice, text alone, as a check or run monitor sends one.
  message("n1", "user", [{ type: "text", text: "fixture failed" }], "server"),
  // A text-only row from before Gram recorded who wrote it.
  message("o1", "user", [{ type: "text", text: "Old and unattributed." }]),
];

describe("userMessagesOf", () => {
  it("keeps only what the user typed, with its files: never notices, digests, other threads' or unattributed rows", () => {
    expect(userMessagesOf(transcript)).toEqual([
      { text: "Set up the repo.", files: [] },
      { text: "Here is the log:\n  at foo (bar.ts:1)", files: ["/tmp/a/log.txt"] },
    ]);
  });
});

describe("withUserWords", () => {
  it("puts the user's words after the text, under a line that says whose they are", () => {
    expect(withUserWords("Fix the crash.", [{ text: "the log", files: [] }])).toBe(
      [
        "Fix the crash.",
        "",
        "---",
        "The user's own words to the orchestrator, their latest message, copied word for word by Gram. Everything below this line is the user's:",
        "",
        "the log",
      ].join("\n"),
    );
  });

  it("numbers several, oldest first, and names files it didn't copy", () => {
    const text = withUserWords("Brief.", [
      { text: "one", files: [] },
      { text: "two", files: ["/tmp/a.png"] },
    ]);
    expect(text).toContain("their latest 2, oldest first");
    expect(
      text.endsWith(
        "[1 of 2]\none\n\n[2 of 2]\ntwo\n(Files attached to it, not copied: /tmp/a.png)",
      ),
    ).toBe(true);
  });

  it("leaves the text alone with nothing to attach", () => {
    expect(withUserWords("Brief.", [])).toBe("Brief.");
  });
});

describe("attachUserWords", () => {
  const caller = "orc" as ThreadId;
  const storeOf = (role: Thread["role"], messages: ReadonlyArray<GramUIMessage>) => ({
    getThread: (id: ThreadId) =>
      id === caller
        ? Effect.succeed({ id, role } as unknown as Thread)
        : Effect.fail(new ThreadNotFound({ threadId: id })),
    listMessages: () => Effect.succeed(messages),
  });

  it.effect("attaches the latest ones the orchestrator asked for", () =>
    Effect.gen(function* () {
      const text = yield* attachUserWords(
        storeOf("orchestrator", transcript),
        "spawn_worker",
        caller,
        "Brief.",
        1,
      );
      expect(text).toContain("Everything below this line is the user's:\n\nHere is the log:");
      expect(text).not.toContain("Set up the repo.");
    }),
  );

  it.effect("passes the text through when none are asked for", () =>
    Effect.gen(function* () {
      expect(
        yield* attachUserWords(storeOf(undefined, []), "send_message", caller, "Hi.", undefined),
      ).toBe("Hi.");
    }),
  );

  it.effect("refuses a thread that isn't an orchestrator, whose user messages may be notices", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        attachUserWords(storeOf(undefined, transcript), "send_message", caller, "Hi.", 1),
      );
      expect(error.message).toContain("this thread isn't one");
    }),
  );

  it.effect("refuses when the user hasn't written, or wrote more than one call attaches", () =>
    Effect.gen(function* () {
      const none = yield* Effect.flip(
        attachUserWords(storeOf("orchestrator", []), "spawn_worker", caller, "Brief.", 2),
      );
      expect(none.message).toContain("no message from the user");
      const long = yield* Effect.flip(
        attachUserWords(
          storeOf("orchestrator", [typed("u", "x".repeat(USER_WORDS_MAX + 1))]),
          "spawn_worker",
          caller,
          "Brief.",
          1,
        ),
      );
      expect(long.message).toContain("Attach fewer");
    }),
  );
});

describe("withBriefFooter", () => {
  it("adds nothing without a footer", () => {
    expect(withBriefFooter("Fix the crash.", undefined)).toBe("Fix the crash.");
  });

  it("puts the footer under its own line, and the user's words after it stay last", () => {
    const text = withUserWords(withBriefFooter("Fix the crash.", "Run the checks."), [
      { text: "the log", files: [] },
    ]);
    expect(text.indexOf(BRIEF_FOOTER_LINE)).toBeGreaterThan(text.indexOf("Fix the crash."));
    expect(text.indexOf("Run the checks.")).toBeGreaterThan(text.indexOf(BRIEF_FOOTER_LINE));
    expect(text.indexOf("Everything below this line is the user's")).toBeGreaterThan(
      text.indexOf("Run the checks."),
    );
    expect(text.endsWith("the log")).toBe(true);
  });
});
