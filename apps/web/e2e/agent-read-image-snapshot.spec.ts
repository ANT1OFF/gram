import { expect, test } from "@playwright/test";
import {
  MessageId,
  type AgentEvent,
  type FileImage,
  type GramUIMessage,
  type ThreadId,
  type InvalidState,
  type NotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK_TOOL_IMAGE } from "../src/api/mock-files";

/** Real mapper, runtime admission/capture, SQLite and attachment reader; browser feed/IPC mocked. */
test("agent-read snapshot survives source deletion and reload without crossing threads", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // Runtime-only test integration keeps server/agent source in their own TypeScript projects.
  const { makeCodexMapper } = (await import(
    new URL("../../../packages/agents/src/codex/mapper.ts", import.meta.url).href
  )) as {
    makeCodexMapper: (options: { newMessageId: () => MessageId }) => {
      map: (notification: unknown) => AgentEvent[];
    };
  };
  const { persistToolImagePreview } = (await import(
    new URL("../../../packages/server/src/runtime/tool-image-preview-fixture.ts", import.meta.url)
      .href
  )) as {
    persistToolImagePreview: (
      dir: string,
      root: string,
      events: AgentEvent[],
    ) => Promise<GramUIMessage[]>;
  };
  const { readThreadAttachment } = (await import(
    new URL("../../../packages/server/src/attachments/attachments.ts", import.meta.url).href
  )) as {
    readThreadAttachment: (
      messages: GramUIMessage[],
      path: string,
    ) => Effect.Effect<FileImage, NotFound | InvalidState>;
  };
  const dir = mkdtempSync(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "gram-image-browser-"),
  );
  const root = join(dir, "checkout");
  mkdirSync(root);
  const source = join(dir, "board-icon-alignment-working-after.png");
  const missing = join(root, "missing-shot.png");
  const outside = join(dir, "board-icon-alignment-nonworking.png");
  const png = Buffer.from(MOCK_TOOL_IMAGE.base64, "base64");
  writeFileSync(source, png);
  writeFileSync(outside, png);
  const threadId = "t-deps" as ThreadId;
  const mapped: AgentEvent[] = [];
  const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("snapshot-message") });
  const wrapper = {
    type: "dynamicToolCall",
    id: "wrapper",
    namespace: "functions",
    tool: "exec",
    arguments: {
      code: `for (const path of ${JSON.stringify([source, outside])}) { const r = await tools.view_image({path}); image(r.image_url); }`,
    },
    status: "inProgress",
    contentItems: null,
    success: null,
    durationMs: null,
  };
  mapped.push(
    ...mapper.map({
      method: "item/started",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        startedAtMs: 1,
        item: wrapper,
      },
    }),
  );
  try {
    for (const [id, path] of [
      ["snapshot", source],
      ["missing-source", missing],
      ["native-second", outside],
    ]) {
      if (id === "native-second")
        mapped.push(
          ...mapper.map({
            method: "item/started",
            params: {
              threadId: "provider-thread",
              turnId: "provider-turn",
              item: { type: "imageView", id, path },
            },
          }),
        );
      const events = mapper.map({
        method: "item/completed",
        params: {
          threadId: "provider-thread",
          turnId: "provider-turn",
          completedAtMs: 1,
          item: { type: "imageView", id: id!, path: path! },
        },
      });
      mapped.push(...events);
      // Keep the individual calls in separate visible groups.
      for (const chunk of [
        { type: "text-start", id: `after-${id}` },
        { type: "text-delta", id: `after-${id}`, delta: `Completed ${id}.` },
        { type: "text-end", id: `after-${id}` },
      ] as const)
        mapped.push({ type: "chunk", messageId: MessageId.make("snapshot-message"), chunk });
    }
    mapped.push(
      ...mapper.map({
        method: "item/completed",
        params: {
          threadId: "provider-thread",
          turnId: "provider-turn",
          completedAtMs: 1,
          item: {
            ...wrapper,
            status: "completed",
            contentItems: [{ type: "inputText", text: "Image forwarding completed" }],
            success: true,
            durationMs: 1,
          },
        },
      }),
    );
    mapped.push(
      { type: "chunk", messageId: MessageId.make("snapshot-message"), chunk: { type: "finish" } },
      { type: "turnEnd", reason: "completed" },
      { type: "status", status: "idle" },
    );
    const persisted = await persistToolImagePreview(dir, root, mapped);
    const saved: GramUIMessage = JSON.parse(
      JSON.stringify(persisted.find((m) => m.id === "snapshot-message")),
    );
    expect(
      saved.parts.find((p) => p.type === "dynamic-tool" && p.toolCallId === "snapshot"),
    ).toMatchObject({
      input: { file_path: source },
      output: { type: "image", path: source },
      state: "output-available",
    });
    expect(JSON.stringify(saved)).not.toContain(MOCK_TOOL_IMAGE.base64);
    expect(JSON.stringify(saved)).not.toContain("codex-image-view");
    // Both native-read external originals go away BEFORE the UI loads.
    rmSync(source);
    rmSync(outside);
    await page.exposeFunction(
      "gramReadSnapshot",
      async (requestedThread: ThreadId, path: string) => {
        const result = await Effect.runPromise(
          readThreadAttachment(requestedThread === threadId ? [saved] : [], path).pipe(
            Effect.match({
              onFailure: (error) => ({ error: { message: error.message, _tag: error._tag } }),
              onSuccess: (image) => ({ image }),
            }),
          ),
        );
        return result;
      },
    );
    const restore = async (targetThread: string) => {
      await page.goto(`/t/${targetThread}`);
      await page.getByLabel("Message", { exact: true }).waitFor();
      await page.evaluate(
        ({ serialized, target }) => {
          const message = JSON.parse(serialized) as GramUIMessage;
          const bridge = window as unknown as {
            gramReadSnapshot: (
              threadId: ThreadId,
              path: string,
            ) => Promise<{
              image?: FileImage;
              error?: { message: string; _tag: string };
            }>;
          };
          window.gramMock!.readAttachment = async (requestedThread, path) => {
            const result = await bridge.gramReadSnapshot(requestedThread, path);
            if (result.error) throw Object.assign(new Error(result.error.message), result.error);
            return result.image!;
          };
          window.gramMock!.simulateMessage(target as ThreadId, message);
        },
        { serialized: JSON.stringify(saved), target: targetThread },
      );
      // A reload forgets which turns were open, and the cards are in a finished turn's fold.
      await page.getByTestId("turn-fold").last().click();
    };
    await restore(threadId);
    await page.getByRole("button", { name: "Read 1 file, used 1 tool", exact: true }).click();
    const card = page.locator('[data-tool-call-id="snapshot"]');
    const image = card.getByRole("img", {
      name: "board-icon-alignment-working-after.png",
      exact: true,
    });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 160))
      .toBe(true);
    const second = page.locator('[data-tool-call-id="native-second"]').getByRole("img");
    await expect(second).toBeVisible();
    await expect
      .poll(() => second.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 160))
      .toBe(true);
    for (const id of ["missing-source"]) {
      await expect(page.locator(`[data-tool-call-id="${id}"]`)).toContainText(
        "Image preview unavailable",
      );
    }
    await card.getByRole("button", { name: /Read/ }).click();
    await expect(card.getByTestId("tool-images")).toHaveAttribute("data-size", "large");
    await image.scrollIntoViewIfNeeded();
    await expect(image).toBeInViewport();
    await expect(card.locator(".gram-expand")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("agent-read-snapshot-card.png") });
    await card
      .getByRole("button", { name: "Open board-icon-alignment-working-after.png", exact: true })
      .click();
    await expect(page.getByTestId("attachment-lightbox").getByRole("img")).toBeVisible();
    await expect(page.getByTestId("attachment-lightbox")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath("agent-read-snapshot-lightbox.png") });
    await page.keyboard.press("Escape");
    await restore(threadId);
    await page.getByRole("button", { name: "Read 1 file, used 1 tool", exact: true }).click();
    await expect(image).toBeVisible();
    await restore("t-flaky");
    await page.getByRole("button", { name: "Read 1 file, used 1 tool", exact: true }).click();
    await expect(card.getByTestId("tool-image-missing")).toContainText("Image no longer available");
    await expect(card.getByRole("img")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("agent-read-other-thread-refused.png") });
    expect(consoleErrors).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
