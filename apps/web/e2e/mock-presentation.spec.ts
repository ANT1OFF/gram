import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { openOrchestratorTile } from "./overview-rail";
import { seedTheme } from "./seed-theme";

// Mocks shown as pictures: an `ask_user` question whose
// options carry the needs-you-home mock's own screenshots and boards, and the card `show_mock`
// puts in a reply. The mock's real files are the fixture, served from this repo; the mock API's
// state is in memory and nothing reaches a provider.

/** Where screenshots go when asked for (`MOCK_SHOTS=<dir>`); none otherwise. */
const SHOTS = process.env["MOCK_SHOTS"];

const FIXTURE = fileURLToPath(
  new URL("../../../docs/design/mocks/needs-you-home/", import.meta.url),
);
/**
 * The mock kit's script as this change makes it (`?theme=`, `hashchange`), served in place of the
 * fixture's own copy, which belongs to that mock and is read here, never changed.
 */
const KIT_JS = fileURLToPath(
  new URL("../../../.agents/skills/mock-build/kit/kit.js", import.meta.url),
);
/** Where a worker's mock sits, in its worktree under the orchestrator's checkout. */
const FOLDER = ".worktrees/feat-needs-you-home/docs/design/mocks/needs-you-home";

const QUESTION = "Which needs-you direction should we build?";
const CONTEXT = "Three directions, each drawn in dark and light.";
const OPTIONS = [
  {
    label: "A Inbox",
    description: "A restored, lighter Inbox view",
    shot: "a-inbox",
    board: "a-inbox",
  },
  {
    label: "B Jump",
    description: "A popover, a jump to the exact turn and a stepper",
    shot: "b-popover",
    board: "b-jump-popover",
  },
  {
    label: "C Hybrid",
    description: "B's popover with quick answers, plus a side panel",
    shot: "c-popover",
    board: "c-hybrid-popover",
  },
] as const;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

let server: Server;
let origin: string;

// The mock's folder on loopback, as the server's preview listener serves a page and what is beside it.
test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split(/[?#]/)[0]!);
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part.startsWith("."))) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(path === "/kit/kit.js" ? KIT_JS : join(FIXTURE, ...parts));
      response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "text/plain" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** The mock's mock.json and screenshots, as the checkout holds them. */
const fixtureFiles = () => ({
  "mock.json": { text: readFileSync(join(FIXTURE, "mock.json"), "utf8") },
  ...Object.fromEntries(
    readdirSync(join(FIXTURE, "shots")).map((name) => [
      `shots/${name}`,
      { mediaType: "image/png", base64: readFileSync(join(FIXTURE, "shots", name), "base64") },
    ]),
  ),
});

interface Seeded {
  readonly workspaceId: string;
  readonly orchestratorThreadId: string;
  readonly folder: string;
}

/** The asks scenario, with the mock in a worker's worktree and the question that picks it. */
const start = async (page: Page, visuals: boolean, mode: "dark" | "light" = "dark") => {
  await page.goto("/t/t-flaky");
  await expect(page.getByTestId("overview-rail")).toBeVisible();
  const made: Seeded = await page.evaluate(
    async ({ files, folder, pageUrl, question, context, options, withVisuals, theme }) => {
      const mock = window.gramMock!;
      const seeded = await mock.simulateAsks();
      const base = mock.simulateCheckoutFiles(seeded.orchestratorThreadId, folder, files);
      mock.previewUrls[`${base}/v1.html`] = pageUrl;
      mock.simulateAskUser(seeded.workspaceId, {
        question,
        context,
        recommended: "C Hybrid",
        options: options.map((option) => ({
          label: option.label,
          description: option.description,
          ...(withVisuals
            ? {
                image: `${base}/shots/${option.shot}-${theme}.png`,
                preview: `${base}/v1.html#${option.board}`,
              }
            : {}),
        })),
        ...(withVisuals ? { mock: `${base}/mock.json` } : {}),
      });
      return { ...seeded, folder: base };
    },
    {
      files: fixtureFiles(),
      folder: FOLDER,
      pageUrl: `${origin}/v1.html`,
      question: QUESTION,
      context: CONTEXT,
      options: OPTIONS,
      withVisuals: visuals,
      theme: mode,
    },
  );
  await openOrchestratorTile(page, made.orchestratorThreadId);
  await expect(page.getByTestId("ask-stack")).toBeVisible();
  return made;
};

const currentAsk = (page: Page) =>
  page.getByTestId("ask-stack").locator('li:not([inert]) [data-testid="ask-item"][data-current]');

/** Steps the stack to the question that picks a direction. */
const toQuestion = async (page: Page) => {
  const stack = page.getByTestId("ask-stack");
  for (let tries = 0; tries < 8; tries++) {
    if ((await currentAsk(page).getByTestId("ask-title").textContent())?.includes(QUESTION)) break;
    await stack.getByTestId("ask-next").click();
  }
  await expect(currentAsk(page).getByTestId("ask-title")).toHaveText(QUESTION);
  return currentAsk(page);
};

const frame = (page: Page, threadId: string) =>
  page.frameLocator(`[data-testid="mock-preview-view"][data-thread="${threadId}"]`);

/** What `show_mock` sends for the fixture, as the server builds it from mock.json and shots/. */
const showMock = (page: Page, threadId: string, folder: string) =>
  page.evaluate(
    ({ target, base, shots }) => {
      const pairs = new Map<string, { dark?: string; light?: string }>();
      for (const name of shots.toSorted()) {
        const [, stem, theme] = /^(.*)-(dark|light)\.png$/.exec(name)!;
        pairs.set(stem!, { ...pairs.get(stem!), [theme!]: `${base}/shots/${name}` });
      }
      window.gramMock!.simulateMessage(
        target as never,
        {
          id: "m-show-mock",
          role: "assistant",
          parts: [
            { type: "text", text: "The needs-you-home mock is ready for review." },
            {
              type: "data-mock",
              id: "show-mock-1",
              data: {
                title: "Needs you home",
                slug: "needs-you-home",
                status: "approved",
                version: 1,
                approved: 1,
                page: `${base}/v1.html`,
                record: `${base}/mock.json`,
                directions: [...pairs].map(([stem, pair]) => ({
                  name: stem.charAt(0).toUpperCase() + stem.slice(1).replaceAll("-", " "),
                  ...(stem === "c-popover" ? { board: "c-hybrid-popover" } : {}),
                  shots: pair,
                })),
              },
            },
          ],
        } as never,
      );
    },
    { target: threadId, base: folder, shots: readdirSync(join(FIXTURE, "shots")) },
  );

test("the question's options show their screenshots, enlarge, and open the mock at their board", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 860 });
  const made = await start(page, true);
  const ask = await toQuestion(page);
  const tiles = ask.getByTestId("option-visual");
  await expect(tiles).toHaveCount(3);
  for (const tile of await tiles.all()) {
    await expect(tile.getByTestId("attachment-thumbnail").getByRole("img")).toBeVisible();
  }
  // Only file names are shown, never a path.
  const text = (await ask.textContent()) ?? "";
  expect(text).not.toContain(made.folder);
  expect(text).not.toContain("/Users/");

  // A click enlarges a screenshot in the lightbox, named by the option and its file.
  await tiles.nth(2).getByTestId("attachment-thumbnail").click();
  const lightbox = page.getByTestId("attachment-lightbox");
  await expect(lightbox).toContainText("C Hybrid · c-popover-dark.png");
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);

  // Open mock goes to the orchestrator's Preview, at that direction's board.
  await ask.getByRole("button", { name: "Open mock: C Hybrid" }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("preview-address")).toHaveValue(
    `${made.folder}/v1.html#c-hybrid-popover`,
  );
  const preview = frame(page, made.orchestratorThreadId);
  // The kit's own board navigation: the board is focused full window, its bar still there.
  await expect(preview.locator("#c-hybrid-popover")).toHaveAttribute("data-focused", "");
  await expect(preview.locator(".mock-bar")).toBeVisible();
  await expect(preview.getByRole("group", { name: "Theme" })).toBeVisible();
  const opened = await page.evaluate(() => window.gramMock!.shell.preview.opened.slice());
  expect(opened.at(-1)).toBe(`${made.orchestratorThreadId} ${origin}/v1.html#c-hybrid-popover`);
});

test("Open mocks opens the current version mock.json names", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 860 });
  const made = await start(page, true);
  const ask = await toQuestion(page);
  await ask.getByTestId("question-open-mocks").click();
  await expect(page.getByTestId("preview-address")).toHaveValue(`${made.folder}/v1.html`);
  await expect(frame(page, made.orchestratorThreadId).locator(".mock-bar")).toBeVisible();
});

test("the mock card shows the directions, switches dark and light, and opens in that theme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 860 });
  const made = await start(page, false);
  await showMock(page, made.orchestratorThreadId, made.folder);
  const card = page.getByTestId("mock-card");
  await expect(card.getByRole("heading", { name: "Needs you home" })).toBeVisible();
  await expect(card.getByTestId("mock-version")).toHaveText("v1");
  await expect(card.getByTestId("mock-status")).toHaveText("Approved");
  await expect(card.getByTestId("mock-direction")).toHaveCount(8);
  await expect(card).not.toContainText(made.folder);

  // Dark and light: the thumbnails follow the toggle.
  const first = card.getByTestId("mock-direction").first().getByRole("img");
  await card.getByRole("button", { name: "dark", exact: true }).click();
  await expect(first).toHaveAttribute("alt", "A inbox · a-inbox-dark.png");
  await card.getByRole("button", { name: "light", exact: true }).click();
  await expect(card).toHaveAttribute("data-shots", "light");
  await expect(first).toHaveAttribute("alt", "A inbox · a-inbox-light.png");

  // Open in Preview opens the version page in the theme the card shows.
  await card.getByTestId("mock-open-preview").click();
  const preview = frame(page, made.orchestratorThreadId);
  await expect(preview.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    preview.getByRole("group", { name: "Theme" }).getByRole("button", { name: "light" }),
  ).toHaveAttribute("aria-pressed", "true");
  // The kit's switch still works inside Preview.
  await preview.getByRole("group", { name: "Theme" }).getByRole("button", { name: "dark" }).click();
  await expect(preview.locator("html")).toHaveAttribute("data-theme", "dark");

  // A direction with a board opens at it.
  await card.getByRole("button", { name: "Open C popover in Preview" }).click();
  await expect(preview.locator("#c-hybrid-popover")).toHaveAttribute("data-focused", "");
});

test("the question and the card fit a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  const made = await start(page, true);
  const ask = await toQuestion(page);
  await expect(ask.getByTestId("option-visual")).toHaveCount(3);
  const noSideScroll = (selector: string) =>
    page.evaluate(
      (query) =>
        [...document.querySelectorAll(query)].every(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      selector,
    );
  expect(await noSideScroll('[data-testid="option-gallery"]')).toBe(true);
  await showMock(page, made.orchestratorThreadId, made.folder);
  await expect(page.getByTestId("mock-card")).toBeVisible();
  expect(await noSideScroll('[data-testid="mock-card"]')).toBe(true);
});

for (const mode of ["dark", "light"] as const) {
  test(`before and after, in ${mode} mode`, async ({ page }) => {
    await seedTheme(page, {
      mode,
      motion: "off",
      palette: mode === "light" ? "catppuccin-latte" : "catppuccin-mocha",
    });
    // Tall enough for the stack and the whole card at once.
    await page.setViewportSize({ width: 1200, height: 1500 });
    const made = await start(page, true, mode);
    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
    const ask = await toQuestion(page);
    for (const tile of await ask.getByTestId("option-visual").all()) {
      await expect(tile.getByRole("img")).toBeVisible();
    }
    await showMock(page, made.orchestratorThreadId, made.folder);
    const card = page.getByTestId("mock-card");
    await expect(card).toHaveAttribute("data-shots", mode);
    for (const image of await card.getByRole("img").all()) await expect(image).toBeVisible();
    if (SHOTS !== undefined) {
      await ask.screenshot({ path: `${SHOTS}/ask-after-${mode}.png` });
      await card.scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
      await expect(card).toBeInViewport({ ratio: 1 });
      await card.screenshot({ path: `${SHOTS}/mock-card-after-${mode}.png` });
    }
  });
}
