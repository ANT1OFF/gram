import { writeFile } from "node:fs/promises";
import type { DraftStash, StashId, ThreadId, UserInput } from "@gram/contracts";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { seedTheme } from "./seed-theme";
import { threadRow } from "./thread-row";

const browserErrors = new WeakMap<Page, string[]>();

declare global {
  interface Window {
    composerLifecycle: {
      stashCalls: {
        threadId: ThreadId;
        draft: { id: StashId; text: string; attachments: DraftStash["attachments"] };
      }[];
      sendCalls: { threadId: ThreadId; input: UserInput }[];
      finishStash: () => void;
      rejectSend: () => void;
    };
  }
}
const paste = (field: Locator, name: string) =>
  field.evaluate((element, fileName) => {
    const data = new DataTransfer();
    data.items.add(new File(["Invented attachment"], fileName, { type: "text/plain" }));
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
  await page.goto("/t/t-deps");
  const field = page.getByRole("combobox", { name: "Message", exact: true });
  await expect(field).toBeVisible();
  await page.evaluate(() => {
    const api = window.gramMock!;
    api.simulateStatus("t-deps" as ThreadId, "running");
    api.simulateStatus("t-release" as ThreadId, "running");
    // These two seeded threads have no autoplay; all streaming events are explicit and deterministic.
    api.simulateChunks("t-deps" as ThreadId, "lifecycle-stream" as never, [
      { type: "start", messageId: "lifecycle-stream" },
      { type: "text-start", id: "lifecycle-text" },
      { type: "text-delta", id: "lifecycle-text", delta: "Invented response in progress." },
    ]);
    const stash = Promise.withResolvers<DraftStash>();
    const send = Promise.withResolvers<{ queued: boolean }>();
    window.composerLifecycle = {
      stashCalls: [],
      sendCalls: [],
      finishStash: () => {
        const call = window.composerLifecycle.stashCalls[0]!;
        stash.resolve({ ...call.draft, threadId: call.threadId, createdAt: 1 });
      },
      rejectSend: () => send.reject(new Error("synthetic late refusal")),
    };
    api.stashDraft = async (threadId, draft) => {
      window.composerLifecycle.stashCalls.push({ threadId, draft });
      return stash.promise;
    };
    api.send = async (threadId, input) => {
      window.composerLifecycle.sendCalls.push({ threadId, input });
      return window.composerLifecycle.sendCalls.length === 1 ? send.promise : { queued: true };
    };
  });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  return field;
};
const switchTo = async (page: Page, threadId: string) => {
  await threadRow(page, threadId).click();
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
};
const evidence = async (page: Page, info: TestInfo, name: string) => {
  const receipt = {
    route: new URL(page.url()).pathname,
    text: await page.getByRole("combobox", { name: "Message", exact: true }).inputValue(),
    chips: await page.getByTestId("attachment-chip").evaluateAll((chips) =>
      chips.map((chip) => ({
        name: chip.textContent,
        path: chip.getAttribute("title"),
        status: chip.getAttribute("data-status"),
      })),
    ),
    calls: await page.evaluate(() => ({
      stashes: window.composerLifecycle.stashCalls,
      sends: window.composerLifecycle.sendCalls,
    })),
  };
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify(receipt, null, 2));
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: "image/png" });
  await info.attach(`${name} receipt`, {
    path: info.outputPath(`${name}.json`),
    contentType: "application/json",
  });
  return receipt;
};
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
});
test.afterEach(async ({ page }, info) => {
  const errors = browserErrors.get(page)!;
  await writeFile(info.outputPath("browser-errors.json"), JSON.stringify(errors));
  await info.attach("browser errors", {
    path: info.outputPath("browser-errors.json"),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
});

test("stash completion preserves the newer draft and files", async ({ page }, info) => {
  const field = await open(page);
  await field.fill("Original draft A");
  await paste(field, "a.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await field.press("ControlOrMeta+s");
  await expect.poll(() => page.evaluate(() => window.composerLifecycle.stashCalls.length)).toBe(1);
  await field.fill("Newer draft B");
  await paste(field, "b.txt");
  await expect(page.getByRole("button", { name: "Remove b.txt" })).toBeVisible();
  await page.evaluate(() => window.composerLifecycle.finishStash());
  await expect(page.getByText("Draft stashed", { exact: true })).toBeVisible();
  const receipt = await evidence(page, info, "stash-result");
  expect(receipt.text).toBe("Newer draft B");
  expect(receipt.chips.map((chip) => chip.path)).toEqual(["/mock/attachments/t-deps/b.txt"]);
  expect(receipt.calls.stashes).toHaveLength(1);
  expect(receipt.calls.stashes[0]!.draft).toMatchObject({
    text: "Original draft A",
    attachments: [
      { path: "/mock/attachments/t-deps/a.txt", name: "a.txt", mediaType: "text/plain" },
    ],
  });
});

test("unsent files belong to their thread across actual sidebar remounts", async ({
  page,
}, info) => {
  const field = await open(page);
  await field.fill("Unsent draft A");
  await paste(field, "unsent.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await switchTo(page, "t-release");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await field.fill("Separate draft B");
  await paste(field, "other.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await switchTo(page, "t-deps");
  const receipt = await evidence(page, info, "remount-result");
  expect(receipt.text).toBe("Unsent draft A");
  expect(receipt.chips.map((chip) => chip.path)).toEqual(["/mock/attachments/t-deps/unsent.txt"]);
  await switchTo(page, "t-release");
  await expect(field).toHaveValue("Separate draft B");
  await expect(page.getByRole("button", { name: "Remove other.txt" })).toBeVisible();
});

test("late failed send recovers files to the original thread and retry retains exact references", async ({
  page,
}, info) => {
  const field = await open(page);
  await field.fill("First draft A");
  await paste(field, "first.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(field).toHaveValue("");
  await switchTo(page, "t-release");
  await field.fill("Separate draft B");
  await paste(field, "other.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await switchTo(page, "t-deps");
  await field.fill("Newer draft A");
  await paste(field, "newer.txt");
  await expect(page.getByTestId("attachment-chip")).toHaveAttribute("data-status", "ready");
  await switchTo(page, "t-release");
  await page.evaluate(() => window.composerLifecycle.rejectSend());
  await expect(field).toHaveValue("Separate draft B");
  await expect(page.getByRole("button", { name: "Remove other.txt" })).toBeVisible();
  await switchTo(page, "t-deps");
  await expect(field).toHaveValue("First draft A\n\nNewer draft A");
  const receipt = await evidence(page, info, "late-send-result");
  expect(receipt.chips.map((chip) => chip.path).toSorted()).toEqual(
    ["/mock/attachments/t-deps/first.txt", "/mock/attachments/t-deps/newer.txt"].toSorted(),
  );
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  const calls = await page.evaluate(() => window.composerLifecycle.sendCalls);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.threadId).toBe("t-deps");
  expect(calls[1]!.input.attachments).toHaveLength(2);
  expect(calls[1]!.input.attachments).toContainEqual(calls[0]!.input.attachments![0]);
  await writeFile(info.outputPath("retry-result.json"), JSON.stringify(calls, null, 2));
});

test("a real image object URL survives a sidebar remount and is revoked once on removal", async ({
  page,
}, info) => {
  const field = await open(page);
  await page.evaluate(() => {
    const revoked: string[] = [];
    Object.assign(window, { lifecycleRevoked: revoked });
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      original(url);
    };
  });
  await field.evaluate((element) => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const data = new DataTransfer();
    data.items.add(new File([bytes], "preview.png", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    element.dispatchEvent(event);
  });
  const chip = page.getByTestId("attachment-chip");
  await expect(chip).toHaveAttribute("data-status", "ready");
  const original = await chip.locator("img").getAttribute("src");
  expect(original).toMatch(/^blob:/);
  await expect
    .poll(() => chip.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(1);
  await switchTo(page, "t-release");
  expect(await page.evaluate(() => Reflect.get(window, "lifecycleRevoked"))).toEqual([]);
  await switchTo(page, "t-deps");
  await expect(chip.locator("img")).toHaveAttribute("src", original!);
  expect(await page.evaluate(async (url) => (await fetch(url!)).status, original)).toBe(200);
  await evidence(page, info, "image-owner-result");
  await chip.getByRole("button", { name: "Remove preview.png" }).click();
  await expect(chip).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "lifecycleRevoked"))).toEqual([original]);
});
