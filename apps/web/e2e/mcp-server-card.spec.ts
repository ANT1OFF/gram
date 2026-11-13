import { expect, test, type Page } from "@playwright/test";

import { seedTheme } from "./seed-theme";

// An MCP server proposed by an agent (`mcp_server_propose`): the card shows everything that would
// be written, and only Approve or Decline. Synthetic mock state; nothing reaches a provider or a
// CLI. Each case also saves a screenshot to the test's output folder for review.

const THREAD = "t-deps";
const TOOL = "mcp__gram__mcp_server_propose";

/** A local server for both agents, as the server's card builder writes it. */
const LOCAL = {
  name: "docs-index",
  action: "add",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/docs-index-mcp", "--root", "/Users/dev/code/docs"],
  commandLine: "npx -y @example/docs-index-mcp --root /Users/dev/code/docs",
  env: [
    { name: "LOG_LEVEL", value: "info" },
    { name: "DOCS_LOCALE", value: "en" },
  ],
  scope: "user",
  scopeText: "User: you, in every project",
  targets: [
    {
      target: "claude",
      label: "Claude Code",
      where: "Claude Code's user config (claude mcp add-json --scope user): every project",
    },
    {
      target: "codex",
      label: "Codex",
      where:
        "Codex's config.toml, [mcp_servers.docs-index]: every project, Gram's own Codex home included",
    },
  ],
  reason: "You asked for search over the local docs from every thread.",
};

/** A remote server that replaces one of the same name. */
const REMOTE = {
  name: "tracker",
  action: "replace",
  transport: "http",
  url: "https://mcp.example.invalid/tracker",
  host: "mcp.example.invalid",
  scope: "user",
  scopeText: "User: you, in every project",
  targets: [
    {
      target: "claude",
      label: "Claude Code",
      where: "Claude Code's user config (claude mcp add-json --scope user): every project",
      replaces: {
        transport: "http",
        scope: "user",
        url: "https://old.example.invalid/mcp",
        carriesValues: true,
      },
    },
  ],
  reason: "The tracker moved to a new address.",
  notes: [
    "If the server asks you to sign in: in Claude Code, run /mcp and choose Authenticate. Gram never sees the token.",
  ],
};

const raise = async (
  page: Page,
  toolName: string,
  input: Record<string, unknown>,
  description: string,
) => {
  await page.goto(`/t/${THREAD}`);
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.evaluate(
    ([threadId, tool, request, said]) =>
      window.gramMock!.simulateRequest(threadId as never, {
        kind: "approval",
        id: `r-mcp-${request["name"]}` as never,
        toolUseId: `mcp-${request["name"]}`,
        toolName: tool,
        displayName: "Add MCP server",
        input: request,
        description: said,
        suggestions: [],
        scopes: ["once"],
      }),
    [THREAD, toolName, input, description] as const,
  );
  const card = page.getByTestId("approval-card").last();
  await card.waitFor();
  return card;
};

for (const [colorScheme, palette] of [
  ["light", "neutral"],
  ["dark", "neutral-dark"],
] as const) {
  test.describe(`in ${colorScheme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await seedTheme(page, { palette, mode: colorScheme, motion: "off" });
    });

    test("a local server shows its command line and env, and says it runs a program", async ({
      page,
    }, testInfo) => {
      const card = await raise(
        page,
        TOOL,
        LOCAL,
        "Add the MCP server “docs-index”, a program run on this machine, in Claude Code and Codex.",
      );
      await expect(card).toContainText("Add MCP server “docs-index”?");
      await expect(card.getByTestId("mcp-runs-program")).toBeVisible();
      await expect(card.getByTestId("mcp-arg")).toHaveText([LOCAL.command, ...LOCAL.args]);
      await expect(card.getByTestId("mcp-env")).toHaveText(["LOG_LEVEL=info", "DOCS_LOCALE=en"]);
      await expect(card.getByTestId("approval-allow")).toContainText("Add server");
      await expect(card.getByTestId("approval-deny")).toBeVisible();
      await expect(card.getByTestId("approval-always")).toHaveCount(0);
      await card.screenshot({ path: testInfo.outputPath(`local-${colorScheme}.png`) });
    });

    test("a remote replacement shows the URL, the host, both servers and the sign-in", async ({
      page,
    }, testInfo) => {
      const card = await raise(
        page,
        TOOL,
        REMOTE,
        "Replace the MCP server “tracker”, a remote server at mcp.example.invalid, in Claude Code.",
      );
      await expect(card).toContainText("Replace MCP server “tracker”?");
      await expect(card.getByTestId("mcp-host")).toContainText("mcp.example.invalid");
      await expect(card.getByTestId("mcp-replaces")).toContainText(
        "https://old.example.invalid/mcp",
      );
      await expect(card.getByTestId("approval-allow")).toContainText("Replace server");
      await card.screenshot({ path: testInfo.outputPath(`remote-${colorScheme}.png`) });
    });

    test("before: the same input on a card that doesn't know it", async ({ page }, testInfo) => {
      const card = await raise(page, "mcp__gram__unknown_tool", LOCAL, "An app tool's card.");
      await card.screenshot({ path: testInfo.outputPath(`before-${colorScheme}.png`) });
    });
  });
}

test("on a short window the card scrolls and its buttons stay on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 520 });
  const card = await raise(
    page,
    TOOL,
    {
      ...LOCAL,
      args: Array.from({ length: 30 }, (_, i) => `--option-${i}`),
      commandLine: `npx ${Array.from({ length: 30 }, (_, i) => `--option-${i}`).join(" ")}`,
      env: Array.from({ length: 12 }, (_, i) => ({ name: `SETTING_${i}`, value: `value-${i}` })),
    },
    "A tall one.",
  );
  for (const id of ["approval-allow", "approval-deny"]) {
    await expect(card.getByTestId(id)).toBeInViewport({ ratio: 1 });
  }
  await expect(page.getByLabel("Message", { exact: true })).toBeInViewport();
});

test("spaces in values show exactly as they would be written, each value's edges visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const args = ["server.js", "a   b", " lead", "trail ", ""];
  const card = await raise(
    page,
    TOOL,
    {
      ...LOCAL,
      command: "node",
      args,
      commandLine: "node server.js 'a   b' ' lead' 'trail ' ''",
      env: [{ name: "MODE", value: " a  b " }],
    },
    "Spaces.",
  );
  // What the user reads, as the browser lays it out: nothing collapsed or trimmed.
  const shown = await card
    .getByTestId("mcp-arg")
    .evaluateAll((chips) => chips.map((chip) => (chip as HTMLElement).innerText));
  expect(shown).toEqual(["node", ...args]);
  const env = card.getByTestId("mcp-env-value");
  expect(await env.evaluate((chip) => (chip as HTMLElement).innerText)).toBe(" a  b ");
  expect(await env.evaluate((chip) => getComputedStyle(chip).whiteSpace)).toBe("pre-wrap");
  // An empty argument is still a chip with an edge, not nothing.
  const empty = card.getByTestId("mcp-arg").last();
  expect((await empty.boundingBox())!.width).toBeGreaterThan(4);
  await card.screenshot({ path: test.info().outputPath("spaces.png") });
});
