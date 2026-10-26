import { writeFile } from "node:fs/promises";
import type { ThreadId, UserInput } from "@gram/contracts";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { seedTheme } from "./seed-theme";

declare global {
  interface Window {
    composerRecovery: {
      calls: { threadId: ThreadId; input: UserInput }[];
      reject: () => void;
    };
  }
}

const paste = (field: Locator, name: string) =>
  field.evaluate((element, fileName) => {
    const data = new DataTransfer();
    data.items.add(new File(["Invented attachment contents"], fileName, { type: "text/plain" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  }, name);

const open = async (page: Page) => {
  await seedTheme(page, { palette: "neutral-dark", mode: "dark", motion: "off" });
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.sessionExpired", "0");
    sessionStorage.setItem("gram.mock.agents", "");
    sessionStorage.setItem("gram.mock.agentRuntimes", JSON.stringify({ agents: [] }));
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [],
        claudeSignIn: "notSignedIn",
        codexSignIn: "notSignedIn",
        ghSignedIn: false,
        agentsInUse: [],
      }),
    );
  });
  await page.goto("/t/t-flaky");
  const field = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(field).toBeVisible();
  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.simulateStatus("t-flaky" as ThreadId, "running");
    mock.simulateChunks("t-flaky" as ThreadId, "recovery-stream" as never, [
      { type: "start", messageId: "recovery-stream" },
      { type: "text-start", id: "recovery-text" },
      { type: "text-delta", id: "recovery-text", delta: "Invented streaming response. " },
    ]);
    const pending = Promise.withResolvers<{ queued: boolean }>();
    window.composerRecovery = {
      calls: [],
      reject: () => pending.reject(new Error("synthetic offline refusal")),
    };
    mock.send = async (threadId, input) => {
      window.composerRecovery.calls.push({ threadId, input });
      return window.composerRecovery.calls.length === 1 ? pending.promise : { queued: true };
    };
  });
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  return field;
};

test.use({ viewport: { width: 1440, height: 900 } });

test("failed queue restores sent files beside a draft typed during streaming and retry keeps references", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const field = await open(page);
  const first = {
    path: "/mock/attachments/t-flaky/first.txt",
    name: "first.txt",
    mediaType: "text/plain",
  };
  const newer = {
    path: "/mock/attachments/t-flaky/newer.txt",
    name: "newer.txt",
    mediaType: "text/plain",
  };
  await field.fill("First direction");
  await paste(field, "first.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await field.fill("Newer direction");
  await paste(field, "newer.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await page.evaluate(() => {
    window.gramMock!.simulateChunks("t-flaky" as ThreadId, "recovery-stream" as never, [
      {
        type: "text-delta",
        id: "recovery-text",
        delta: "More invented text while the next draft is typed.",
      },
    ]);
    window.composerRecovery.reject();
  });
  await expect(field).toHaveValue("First direction\n\nNewer direction");
  await expect(page.getByText("Couldn't send: synthetic offline refusal")).toBeVisible();
  const receipt = {
    draft: await field.inputValue(),
    chips: await page.getByTestId("attachment-chip").evaluateAll((chips) =>
      chips.map((chip) => ({
        name: chip.textContent,
        path: chip.getAttribute("title"),
        status: chip.getAttribute("data-status"),
      })),
    ),
    calls: await page.evaluate(() => window.composerRecovery.calls),
    errors,
  };
  await page.screenshot({ path: testInfo.outputPath("failed-queue.png") });
  await writeFile(testInfo.outputPath("recovery-receipt.json"), JSON.stringify(receipt, null, 2));
  await testInfo.attach("failed queue visible result", {
    path: testInfo.outputPath("failed-queue.png"),
    contentType: "image/png",
  });
  await testInfo.attach("recovery receipt", {
    path: testInfo.outputPath("recovery-receipt.json"),
    contentType: "application/json",
  });
  expect(receipt.chips.map((chip) => chip.path).toSorted()).toEqual(
    [first.path, newer.path].toSorted(),
  );
  expect(receipt.calls).toEqual([
    { threadId: "t-flaky", input: { text: "First direction", attachments: [first] } },
  ]);
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  const calls = await page.evaluate(() => window.composerRecovery.calls);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({
    threadId: "t-flaky",
    input: { text: "First direction\n\nNewer direction", attachments: [newer, first] },
  });
  expect(errors).toEqual([]);
  await writeFile(
    testInfo.outputPath("retry-receipt.json"),
    JSON.stringify({ calls, errors }, null, 2),
  );
});

test("failed Send and start a new draft stays on its thread, successful retry opens the draft route", async ({
  page,
}, testInfo) => {
  const field = await open(page);
  await field.fill("Keep this draft");
  await paste(field, "keep.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("send-menu-trigger").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Send and start a new draft/ }).click();
  await expect(field).toHaveValue("");
  await page.evaluate(() => window.composerRecovery.reject());
  await expect.poll(() => page.evaluate(() => window.composerRecovery.calls.length)).toBe(1);
  // Allow the rejection continuation to commit before recording route and visible draft.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({ path: testInfo.outputPath("failed-new-draft.png") });
  await writeFile(
    testInfo.outputPath("new-draft-receipt.json"),
    JSON.stringify(
      {
        route: new URL(page.url()).pathname,
        calls: await page.evaluate(() => window.composerRecovery.calls),
        composerCount: await field.count(),
      },
      null,
      2,
    ),
  );
  await testInfo.attach("failed new draft visible result", {
    path: testInfo.outputPath("failed-new-draft.png"),
    contentType: "image/png",
  });
  await expect(page).toHaveURL(/\/t\/t-flaky$/);
  await expect(field).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Remove keep.txt" })).toBeVisible();
  await page.getByTestId("send-menu-trigger").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Send and start a new draft/ }).click();
  await expect(page).toHaveURL(/\/new$/);
  expect(await page.evaluate(() => window.composerRecovery.calls.length)).toBe(2);
});
