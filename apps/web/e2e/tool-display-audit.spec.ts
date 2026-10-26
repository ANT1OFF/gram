import type { GramUIMessage } from "@gram/contracts";
import { expect, test } from "@playwright/test";

const messages = [
  {
    id: "audit-web",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "WebSearch",
        toolCallId: "web",
        state: "output-available",
        input: { queries: ["synthetic query one", "synthetic query two"] },
      },
    ],
  },
  {
    id: "audit-read",
    role: "assistant",
    parts: [
      {
        type: "tool-Read",
        toolCallId: "read",
        state: "output-available",
        input: { file_path: "/repo/config.ts" },
        output: {
          type: "text",
          file: { content: "export const audit = true;", numLines: 1, totalLines: 1 },
        },
      },
    ],
  },
  {
    id: "audit-search",
    role: "assistant",
    parts: [
      {
        type: "tool-WebSearch",
        toolCallId: "search",
        state: "output-available",
        input: { query: "synthetic source" },
        output: {
          results: [
            "Related synthetic results",
            { content: [{ title: "Synthetic source", url: "https://example.com/audit" }] },
          ],
        },
      },
    ],
  },
  {
    id: "audit-cancel",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "Bash",
        toolCallId: "cancel",
        state: "output-error",
        input: { command: "echo blocked" },
        errorText: "Cancelled",
      },
      {
        type: "tool-Read",
        toolCallId: "missing",
        state: "output-error",
        input: { file_path: "/missing.ts" },
        errorText: "File not found",
      },
    ],
  },
] as unknown as GramUIMessage[];

test.beforeEach(async ({ page }) => {
  // Supply persisted synthetic messages through the existing mock feed, including after reload.
  await page.addInitScript((fixtureMessages: unknown) => {
    Object.defineProperty(window, "gramMock", {
      configurable: true,
      set(mock: NonNullable<typeof window.gramMock>) {
        const original = mock.threadFeed.bind(mock);
        mock.threadFeed = async function* (...args) {
          for await (const event of original(...args)) {
            yield event.type === "messages"
              ? { ...event, messages: fixtureMessages as GramUIMessage[] }
              : event;
          }
        };
        Object.defineProperty(window, "gramMock", {
          value: mock,
          writable: true,
          configurable: true,
        });
      },
    });
  }, messages as unknown);
});

test("tool cards retain supplied data and distinguish missing web details after reload", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const web = page.locator('[data-tool-call-id="web"]');
  await expect(web).toContainText("synthetic query one; synthetic query two");
  await web.getByRole("button").click();
  await expect(web).toContainText("No result details were provided.");
  const read = page.locator('[data-tool-call-id="read"]');
  await read.getByRole("button").click();
  await expect(read).toContainText("export const audit = true;");
  await read.scrollIntoViewIfNeeded();
  const search = page.locator('[data-tool-call-id="search"]');
  await search.getByRole("button").click();
  await expect(search).toContainText("Related synthetic results");
  await expect(search.getByRole("link", { name: "Synthetic source" })).toHaveAttribute(
    "href",
    "https://example.com/audit",
  );
  await page.reload();
  await expect(web).toContainText("synthetic query one");
  await web.getByRole("button").click();
  await expect(web).toContainText("No result details were provided.");
});

test("cancellation does not inflate failure counts", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const group = page.getByTestId("tool-group");
  await expect(group).toContainText("1 failed");
  await expect(group).toContainText("1 cancelled");
  await group.getByRole("button").click();
  const cancelled = page.locator('[data-tool-call-id="cancel"]');
  await expect(cancelled).toContainText("echo blocked");
  await expect(cancelled).toContainText("Cancelled");
  await expect(page.locator('[data-tool-call-id="missing"]')).toContainText("Error");
  await cancelled.scrollIntoViewIfNeeded();
});
