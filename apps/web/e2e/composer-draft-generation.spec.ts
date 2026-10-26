import { writeFile } from "node:fs/promises";
import type { ThreadId, UserInput } from "@gram/contracts";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { threadRow } from "./thread-row";

const A = "t-deps" as ThreadId;
const B = "t-release" as ThreadId;
const errors = new WeakMap<Page, string[]>();
declare global {
  interface Window {
    composerGeneration: {
      events: {
        type: string;
        threadId?: ThreadId;
        threads?: { id: ThreadId; createdAt: number }[];
      }[];
      sends: { threadId: ThreadId; input: UserInput }[];
      reject: () => void;
      settled: boolean;
      revoked: string[];
    };
  }
}
const field = (page: Page) => page.getByRole("combobox", { name: "Message", exact: true });
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  const e: string[] = [];
  errors.set(page, e);
  page.on("pageerror", (error) => e.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") e.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "gram.theme",
      JSON.stringify({
        state: {
          look: "glass",
          palette: "neutral-dark",
          mode: "dark",
          density: "compact",
          contrast: "system",
          motion: "off",
          customPalettes: [],
        },
        version: 1,
      }),
    );
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({
        appearance: {
          look: "glass",
          paletteId: "neutral-dark",
          mode: "dark",
          density: "compact",
          contrast: "standard",
          motion: "off",
        },
      }),
    );
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
    window.composerGeneration = {
      events: [],
      sends: [],
      reject: () => {},
      settled: false,
      revoked: [],
    };
    let mock: Window["gramMock"];
    Object.defineProperty(window, "gramMock", {
      configurable: true,
      get: () => mock,
      set: (api: NonNullable<Window["gramMock"]>) => {
        mock = api;
        const original = api.events.bind(api);
        api.events = async function* (signal) {
          for await (const event of original(signal)) {
            window.composerGeneration.events.push({
              type: event.type,
              ...("threadId" in event ? { threadId: event.threadId } : {}),
              ...(event.type === "threads.snapshot"
                ? {
                    threads: event.threads.map((t) => ({
                      id: t.thread.id,
                      createdAt: t.thread.createdAt,
                    })),
                  }
                : {}),
            });
            yield event;
          }
        };
      },
    });
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      window.composerGeneration.revoked.push(url);
      original(url);
    };
  });
});
test.afterEach(async ({ page }, info) => {
  await writeFile(info.outputPath("errors.json"), JSON.stringify(errors.get(page)));
  expect(errors.get(page)).toEqual([]);
});
const open = async (page: Page) => {
  await page.goto(`/t/${A}`);
  await expect(field(page)).toBeVisible();
  await page.evaluate(
    ({ A: threadA, B: threadB }) => {
      const api = window.gramMock!;
      api.simulateStatus(threadA, "running");
      api.simulateStatus(threadB, "running");
      const pending = Promise.withResolvers<{ queued: boolean }>();
      window.composerGeneration.reject = () =>
        pending.reject(new Error("invented old RPC refusal"));
      api.send = async (threadId, input) => {
        window.composerGeneration.sends.push({ threadId, input });
        return pending.promise.finally(() => {
          window.composerGeneration.settled = true;
        });
      };
    },
    { A, B },
  );
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
};
const paste = async (page: Page, name: string, image = false) => {
  await field(page).evaluate(
    (element, { name: fileName, image: isImage }) => {
      const bytes = isImage
        ? Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            ),
            (c) => c.charCodeAt(0),
          )
        : new TextEncoder().encode("Invented bytes");
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: isImage ? "image/png" : "text/plain" }));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      element.dispatchEvent(event);
    },
    { name, image },
  );
  await expect(page.getByTestId("attachment-chip").last()).toHaveAttribute("data-status", "ready");
};
const switchTo = async (page: Page, id: ThreadId) => {
  await threadRow(page, id).click();
  await expect(page).toHaveURL(new RegExp(`/t/${id}$`));
  await expect(field(page)).toBeVisible();
};
const lifetime = (page: Page) =>
  page.evaluate(
    () =>
      window.composerGeneration.events
        .filter((e) => e.type === "threads.snapshot")
        .at(-1)!
        .threads!.find((t) => t.id === "t-deps")!.createdAt,
  );
const missedReopen = async (page: Page) => {
  const old = await lifetime(page);
  const reopened = await page.evaluate(async (id) => {
    const api = window.gramMock!;
    api.simulateDisconnect();
    await api.closeThread(id);
    const summary = await api.reopenClosedThread();
    if (summary === null) throw new Error("Invented reopen unexpectedly returned no thread");
    return summary.thread;
  }, A);
  expect(reopened).toBeDefined();
  expect(reopened!.id).toBe(A);
  await expect.poll(() => lifetime(page)).toBe(reopened!.createdAt);
  expect(reopened!.createdAt).not.toBe(old);
  expect(
    await page.evaluate(() =>
      window.composerGeneration.events.filter(
        (e) => e.type === "thread.removed" && e.threadId === "t-deps",
      ),
    ),
  ).toEqual([]);
};
const receipt = async (page: Page, info: TestInfo) => {
  const result = {
    route: new URL(page.url()).pathname,
    text: await field(page).inputValue(),
    chips: await page.getByTestId("attachment-chip").evaluateAll((chips) =>
      chips.map((chip) => ({
        path: chip.getAttribute("title"),
        status: chip.getAttribute("data-status"),
        image: chip.querySelector("img")?.getAttribute("src"),
      })),
    ),
    state: await page.evaluate(() => window.composerGeneration),
  };
  await writeFile(info.outputPath("receipt.json"), JSON.stringify(result, null, 2));
  await page.screenshot({ path: info.outputPath("visible.png") });
  await info.attach("generation result", {
    path: info.outputPath("visible.png"),
    contentType: "image/png",
  });
  return result;
};
test("missed close/reopen fences old send failure after remount", async ({ page }, info) => {
  await open(page);
  await field(page).fill("Old lifetime");
  await paste(page, "old.txt");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(field(page)).toHaveValue("");
  await switchTo(page, B);
  await missedReopen(page);
  await switchTo(page, A);
  await field(page).fill("Reopened lifetime");
  await paste(page, "new.txt");
  await page.evaluate(() => window.composerGeneration.reject());
  await expect.poll(() => page.evaluate(() => window.composerGeneration.settled)).toBe(true);
  const result = await receipt(page, info);
  expect(result.text).toBe("Reopened lifetime");
  expect(result.chips.map((chip) => chip.path)).toEqual(["/mock/attachments/t-deps/new.txt"]);
});
test("missed close/reopen releases old decoded image owner", async ({ page }, info) => {
  await open(page);
  await paste(page, "old-preview.png", true);
  const image = page.getByTestId("attachment-chip").locator("img");
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
  const url = await image.getAttribute("src");
  await switchTo(page, B);
  await missedReopen(page);
  await switchTo(page, A);
  const result = await receipt(page, info);
  expect(result.chips).toEqual([]);
  expect(result.state.revoked).toEqual([url]);
});
test("mounted same-ID composer selects reopened lifetime and can paste a new image", async ({
  page,
}, info) => {
  await open(page);
  await paste(page, "old-preview.png", true);
  const oldUrl = await page.getByTestId("attachment-chip").locator("img").getAttribute("src");
  await missedReopen(page);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await paste(page, "new-preview.png", true);
  const image = page.getByTestId("attachment-chip").locator("img");
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
  const result = await receipt(page, info);
  expect(result.chips.map((chip) => chip.path)).toEqual([
    "/mock/attachments/t-deps/new-preview.png",
  ]);
  expect(result.state.revoked).toEqual([oldUrl]);
});
test("same-lifetime reconnect preserves a preview across ordinary remount", async ({
  page,
}, info) => {
  await open(page);
  await paste(page, "keep.png", true);
  const url = await page.getByTestId("attachment-chip").locator("img").getAttribute("src");
  const oldLifetime = await lifetime(page);
  const oldSnapshots = await page.evaluate(
    () => window.composerGeneration.events.filter((e) => e.type === "threads.snapshot").length,
  );
  await page.evaluate(() => window.gramMock!.simulateDisconnect());
  await expect
    .poll(() =>
      page.evaluate(
        () => window.composerGeneration.events.filter((e) => e.type === "threads.snapshot").length,
      ),
    )
    .toBeGreaterThan(oldSnapshots);
  expect(await lifetime(page)).toBe(oldLifetime);
  await switchTo(page, B);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await switchTo(page, A);
  const image = page.getByTestId("attachment-chip").locator("img");
  await expect(image).toHaveAttribute("src", url!);
  await expect.poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
  expect(await page.evaluate(async (blobUrl) => (await fetch(blobUrl!)).status, url)).toBe(200);
  const result = await receipt(page, info);
  expect(result.state.revoked).toEqual([]);
  await page.getByRole("button", { name: "Remove keep.png" }).click();
  expect(await page.evaluate(() => window.composerGeneration.revoked)).toEqual([url]);
});
