import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  boardSlug,
  directionsFromShots,
  MockCardData,
  mockRefKind,
  parseMockRecord,
  pathName,
  shotFor,
  splitPreviewTarget,
  visualsProblem,
} from "./mock-visuals.ts";
import { askQuestion, closeQuestion, parseQuestions, QuestionChoice } from "./questions.ts";
import { askQuestionProblem } from "./worker-questions.ts";

describe("pathName long separator runs", () => {
  it("keeps the last component with mixed separators and trims only the ends", () => {
    const separators = "/\\".repeat(50_000);
    const started = performance.now();
    expect(pathName(` /repo/${separators}leaf `)).toBe("leaf");
    expect(pathName(` /repo/leaf${separators} `)).toBe("leaf");
    expect(pathName(separators)).toBe("");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// The needs-you-home mock's own files, as the design-brief worker left them.
const MOCK = "/repo/.worktrees/feat-needs-you-home/docs/design/mocks/needs-you-home";
const SHOTS = [
  "a-inbox-dark.png",
  "a-inbox-empty-dark.png",
  "a-inbox-light.png",
  "b-landed-dark.png",
  "b-landed-light.png",
  "b-popover-dark.png",
  "b-popover-empty-light.png",
  "b-popover-light.png",
  "c-panel-dark.png",
  "c-panel-empty-light.png",
  "c-panel-light.png",
  "c-popover-dark.png",
  "c-popover-light.png",
];

const options = [
  {
    label: "A Inbox",
    description: "A restored, lighter Inbox view",
    image: `${MOCK}/shots/a-inbox-dark.png`,
    preview: `${MOCK}/v1.html#a-inbox`,
  },
  {
    label: "B Jump",
    description: "A popover and a jump to the exact turn",
    image: `${MOCK}/shots/b-popover-dark.png`,
    preview: `${MOCK}/v1.html#b-jump-popover`,
  },
  {
    label: "C Hybrid",
    description: "B's popover plus a side panel behind See all",
    image: `${MOCK}/shots/c-popover-dark.png`,
  },
];

describe("the option and question schema", () => {
  it("takes an image and a preview on a choice, and nothing else new", () => {
    const decode = Schema.decodeUnknownSync(QuestionChoice);
    expect(decode(options[0])).toEqual(options[0]);
    expect(decode({ label: "Plain" })).toEqual({ label: "Plain" });
    expect(() => decode({ label: "A", image: 3 })).toThrow();
  });

  it("refuses visuals of the wrong kind before anything is kept", () => {
    expect(visualsProblem(options, `${MOCK}/mock.json`)).toBeUndefined();
    expect(visualsProblem([{ label: "A", image: `${MOCK}/v1.html` }], undefined)).toMatch(
      /A's image has to be a PNG, JPEG, WebP or GIF screenshot: v1.html isn't one/,
    );
    expect(visualsProblem([{ label: "A", preview: `${MOCK}/shots/a.png` }], undefined)).toMatch(
      /A's preview has to be a mock page/,
    );
    expect(
      visualsProblem([{ label: "A", preview: `${MOCK}/v1.html#<script>` }], undefined),
    ).toMatch(/board after the #/);
    expect(visualsProblem([], `${MOCK}/brief.md`)).toMatch(
      /`mock` has to be a mock's mock.json or one of its HTML pages: brief.md is neither/,
    );
    // The worker's `ask_question` refuses the same.
    expect(
      askQuestionProblem({
        question: "Which?",
        options: options.slice(0, 2),
        mock: "notes.txt",
      }),
    ).toMatch(/`mock` has to be/);
    expect(
      askQuestion(undefined, { question: "Which?", options, mock: "x.pdf" }, "2026-10-19"),
    ).toEqual({ ok: false, problem: expect.stringMatching(/`mock` has to be/) });
  });
});

describe("questions.md with visuals", () => {
  const asked = askQuestion(
    undefined,
    {
      question: "Which needs-you direction should we build?",
      context: "Three directions, screenshots in shots/.",
      options,
      recommended: "C Hybrid",
      mock: `${MOCK}/mock.json`,
    },
    "2026-10-19",
  );

  it("writes each choice's image and preview under it, and the mock after the choices", () => {
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.content).toContain(
      [
        "Options (pick one):",
        "1. A Inbox — A restored, lighter Inbox view",
        `   Image: ${MOCK}/shots/a-inbox-dark.png`,
        `   Preview: ${MOCK}/v1.html#a-inbox`,
        "2. B Jump — A popover and a jump to the exact turn",
        `   Image: ${MOCK}/shots/b-popover-dark.png`,
        `   Preview: ${MOCK}/v1.html#b-jump-popover`,
        "3. C Hybrid — B's popover plus a side panel behind See all (recommended)",
        `   Image: ${MOCK}/shots/c-popover-dark.png`,
        `Mock: ${MOCK}/mock.json`,
      ].join("\n"),
    );
  });

  it("reads them back as they were asked, kept out of the detail", () => {
    if (!asked.ok) throw new Error(asked.problem);
    const [question] = parseQuestions(asked.content);
    expect(question).toMatchObject({
      id: "Q1",
      detail: "Three directions, screenshots in shots/.",
      options,
      recommended: "C Hybrid",
      mock: `${MOCK}/mock.json`,
    });
    // Written back unchanged by an edit that leaves them be.
    const again = askQuestion(asked.content, { id: "Q1", question: question!.text }, "2026-10-20");
    expect(again.ok && again.content).toBe(asked.content);
  });

  it('drops the mock with `""`, and the pictures once the question is closed', () => {
    if (!asked.ok) throw new Error(asked.problem);
    const cleared = askQuestion(
      asked.content,
      { id: "Q1", question: "Which needs-you direction should we build?", mock: "" },
      "2026-10-19",
    );
    expect(cleared.ok && parseQuestions(cleared.content)[0]?.mock).toBeUndefined();
    const closed = closeQuestion(asked.content, { id: "Q1", answer: "C", how: "decided" }, "x");
    if (!closed.ok) throw new Error(closed.problem);
    expect(closed.content).not.toContain("Image:");
    expect(closed.content).not.toContain("Mock:");
  });

  it("leaves a line that only looks like one as the detail it is", () => {
    const [question] = parseQuestions(
      [
        "## Q2 · open",
        "Ship it?",
        "Mock: the one from Tuesday",
        "Options (pick one):",
        "1. Yes",
        "   Image: not a picture",
        "2. No",
      ].join("\n"),
    );
    expect(question?.mock).toBeUndefined();
    // As any line that isn't a choice, it ends the list.
    expect(question?.options).toEqual([{ label: "Yes" }]);
    expect(question?.detail).toBe("Mock: the one from Tuesday\nImage: not a picture\nNo");
  });
});

describe("the mock card's pieces", () => {
  it("names a path by its file name only", () => {
    expect(pathName(`${MOCK}/shots/a-inbox-dark.png`)).toBe("a-inbox-dark.png");
    expect(pathName("C:\\repo\\mock.json")).toBe("mock.json");
    expect(pathName(`${MOCK}/`)).toBe("needs-you-home");
  });

  it("takes a preview target apart into its page and board", () => {
    expect(splitPreviewTarget(`${MOCK}/v1.html#c-hybrid-popover`)).toEqual({
      path: `${MOCK}/v1.html`,
      board: "c-hybrid-popover",
    });
    expect(splitPreviewTarget(`${MOCK}/v1.html`)).toEqual({
      path: `${MOCK}/v1.html`,
      board: undefined,
    });
    expect(boardSlug("C Hybrid · popover")).toBe("c-hybrid-popover");
    expect(mockRefKind(`${MOCK}/mock.json`)).toBe("record");
    expect(mockRefKind(`${MOCK}/v1.html#a-inbox`)).toBe("page");
    expect(mockRefKind(`${MOCK}/brief.md`)).toBeUndefined();
  });

  it("pairs shots/ into directions by name, dark with light", () => {
    const directions = directionsFromShots([...SHOTS, ".DS_Store", "notes.txt"]);
    expect(directions.map((direction) => direction.name)).toEqual([
      "A inbox",
      "A inbox empty",
      "B landed",
      "B popover",
      "B popover empty",
      "C panel",
      "C panel empty",
      "C popover",
    ]);
    expect(directions[0]!.shots).toEqual({ dark: "a-inbox-dark.png", light: "a-inbox-light.png" });
    expect(directions[1]!.shots).toEqual({ dark: "a-inbox-empty-dark.png" });
    expect(shotFor(directions[1]!.shots, "light")).toBe("a-inbox-empty-dark.png");
  });

  it("reads mock.json forgivingly, with named directions when it has them", () => {
    expect(
      parseMockRecord(
        JSON.stringify({
          title: "Needs you home",
          slug: "needs-you-home",
          status: "approved",
          current: 1,
          approved: 1,
          versions: [{ n: 1, file: "v1.html" }, { n: 2, file: "../../etc/passwd" }, "junk"],
          directions: [
            {
              name: "C Hybrid",
              board: "c-hybrid-popover",
              shots: { dark: "shots/c-popover-dark.png", light: "shots/c-popover-light.svg" },
            },
            { board: "nameless" },
          ],
        }),
      ),
    ).toEqual({
      title: "Needs you home",
      slug: "needs-you-home",
      status: "approved",
      current: 1,
      approved: 1,
      versions: [{ n: 1, file: "v1.html" }],
      directions: [
        {
          name: "C Hybrid",
          board: "c-hybrid-popover",
          shots: { dark: "shots/c-popover-dark.png" },
        },
      ],
    });
    expect(parseMockRecord("not json")).toBeUndefined();
    expect(parseMockRecord("[]")).toBeUndefined();
  });

  it("decodes the card the server sends", () => {
    const card = {
      title: "Needs you home",
      version: 1,
      approved: 1,
      status: "approved",
      page: `${MOCK}/v1.html`,
      record: `${MOCK}/mock.json`,
      directions: [{ name: "A inbox", shots: { dark: `${MOCK}/shots/a-inbox-dark.png` } }],
    };
    expect(Schema.decodeUnknownSync(MockCardData)(card)).toEqual(card);
  });
});
