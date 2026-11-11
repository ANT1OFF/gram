import { expect, test } from "@playwright/test";

import {
  ASK_ARM_MS,
  askAnswerOf,
  askPage,
} from "../../../packages/shell/src/modules/device/ask-page";

// The lent machine's ask window, drawn in a real browser: its content as text only, and an allow
// that takes a pointer click on content that has been on screen a full second.

const colors = {
  background: "#ffffff",
  foreground: "#111111",
  muted: "#666666",
  border: "#cccccc",
  accent: "#2255ff",
  warning: "#aa5500",
};

const view = (command: string) => ({
  heading: "Run a command",
  kind: "exec",
  server: "https://gram.example.com",
  folderPath: "/home/ada/code/app",
  grantLine: "You wrote to this thread from this computer at 14:02.",
  says: [
    {
      label: "Thread",
      display: {
        pieces: [{ kind: "text", text: '<img src=x onerror="document.title=1">' }],
        hidden: false,
        nonAscii: false,
      },
    },
  ],
  target: {
    pieces: [
      { kind: "text", text: command },
      { kind: "escape", text: "\\u202e" },
      { kind: "newline" },
    ],
    hidden: true,
    nonAscii: false,
  },
  targetLabel: "The command, as it will run",
  facts: ["Runs npm", "Runs code from this folder (npm)"],
  warnings: ["This has characters you can't see, drawn as codes."],
  allowLabel: "Run once",
  refuseLabel: "Don't run",
});

const answers = (titles: ReadonlyArray<string>) =>
  titles
    .map(askAnswerOf)
    .filter((answer) => answer !== undefined)
    .map((answer) => answer.answer);

test.describe("the ask window's page", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(askPage(colors));
  });

  test("draws everything as text, and allows only a pointer click after a full second", async ({
    page,
  }) => {
    const titles: Array<string> = [];
    await page.exposeFunction("seen", (title: string) => titles.push(title));
    await page.evaluate(() => {
      new MutationObserver(() =>
        (window as unknown as { seen: (t: string) => void }).seen(document.title),
      ).observe(document.querySelector("title")!, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await page.evaluate(
      (shown) =>
        (window as unknown as { showAsk: (id: string, v: unknown) => void }).showAsk(
          "show-aaaaaaaa",
          shown,
        ),
      view("npm test"),
    );
    await expect(page.locator("#says img")).toHaveCount(0);
    await expect(page.locator("#says")).toContainText('<img src=x onerror="document.title=1">');
    await expect(page.locator("#target .esc")).toHaveText("\\u202e");
    const allow = page.locator("#allow");
    await expect(allow).toBeDisabled();
    // Too soon, a script's click, and a key on the button: none of them allow.
    await allow.click({ force: true });
    await page.evaluate(() => (document.getElementById("allow") as HTMLButtonElement).click());
    await page.waitForTimeout(ASK_ARM_MS + 200);
    await expect(allow).toBeEnabled();
    await page.evaluate(() => (document.getElementById("allow") as HTMLButtonElement).click());
    await allow.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(answers(titles)).toEqual([]);
    await allow.click();
    await expect.poll(() => answers(titles)).toEqual(["allow"]);
  });

  test("starts the second again for new content, and keeps a withdrawn ask until dismissed", async ({
    page,
  }) => {
    const show = (id: string, command: string) =>
      page.evaluate(
        ([showId, shown]) =>
          (window as unknown as { showAsk: (id: string, v: unknown) => void }).showAsk(
            showId as string,
            shown,
          ),
        [id, view(command)] as const,
      );
    await show("show-aaaaaaaa", "npm test");
    await page.waitForTimeout(ASK_ARM_MS - 300);
    await show("show-bbbbbbbb", "make");
    await page.waitForTimeout(500);
    await expect(page.locator("#allow")).toBeDisabled();
    await page.evaluate(() =>
      (window as unknown as { withdrawAsk: (id: string, why: string) => void }).withdrawAsk(
        "show-bbbbbbbb",
        "Withdrawn",
      ),
    );
    await expect(page.locator("#status")).toHaveText("Withdrawn");
    await expect(page.locator("#allow")).toBeHidden();
    await expect(page.locator("#dismiss")).toBeVisible();
    await page.locator("#dismiss").click();
    expect(askAnswerOf(await page.title())).toEqual({ show: "show-bbbbbbbb", answer: "dismiss" });
  });
});
