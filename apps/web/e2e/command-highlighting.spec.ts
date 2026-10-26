import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./seed-theme";

// Invented content only. These commands are displayed, never executed.
const command = `printf '%s\\n' '{"items":[1,2,3]}' | jq '\n  .items[] | select(. > 1)\n'\nprintf '%s\\n' "$HOME" && echo "done"\n`;
const stdout = '{"selected":[2,3]}\n';
const stderr = "synthetic warning\n";
const phase = process.env["GRAM_COMMAND_SHOTS_PHASE"] ?? "after";
if (phase !== "before" && phase !== "after") throw new Error(`Unknown screenshot phase: ${phase}`);

async function seed(
  page: Page,
  provider: "claude" | "codex",
  text = command,
  state = "output-available",
) {
  await page.addInitScript(
    (fixture) => {
      sessionStorage.setItem("gram.mock.agents", "claude,codex");
      sessionStorage.setItem(
        "gram.mock.launchChecks",
        JSON.stringify({
          claudeSignIn: "signedIn",
          codexSignIn: "signedIn",
          ghSignedIn: false,
          tools: [
            { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
            { tool: "codex", found: true, path: "/mock/bin/codex", version: "0.162.1" },
            { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
            { tool: "gh", found: false },
          ],
        }),
      );
      const messages = [
        {
          id: "synthetic-user",
          role: "user",
          parts: [{ type: "text", text: "Inspect this synthetic JSON with jq." }],
        },
        {
          id: "synthetic-command",
          role: "assistant",
          metadata: {
            agent: fixture.provider,
            model: fixture.provider === "claude" ? "opus" : "gpt-5.5",
          },
          parts: [
            {
              ...(fixture.provider === "claude"
                ? { type: "tool-Bash" }
                : { type: "dynamic-tool", toolName: "Bash" }),
              toolCallId: "synthetic-shell",
              state: fixture.state,
              input: {
                command: fixture.text,
                ...(fixture.provider === "codex"
                  ? { cwd: "/synthetic/project" }
                  : { description: "Filter a synthetic JSON array" }),
              },
              ...(fixture.state === "output-error"
                ? { errorText: "Cancelled" }
                : {
                    output: {
                      stdout: fixture.stdout,
                      stderr: fixture.provider === "claude" ? fixture.stderr : "",
                      interrupted: false,
                      ...(fixture.provider === "codex" ? { exitCode: 0 } : {}),
                    },
                  }),
              providerExecuted: true,
            },
          ],
        },
      ];
      Object.defineProperty(window, "gramMock", {
        configurable: true,
        set(mock: NonNullable<typeof window.gramMock>) {
          const original = mock.threadFeed.bind(mock);
          mock.threadFeed = async function* (...args) {
            for await (const event of original(...args)) {
              yield event.type === "messages"
                ? { ...event, messages: messages as never, earlier: false }
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
    },
    { provider, text, state, stdout, stderr },
  );
}

async function open(page: Page, provider: "claude" | "codex") {
  await page.goto("/t/t-deps");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(async (fixtureProvider) => {
    await window.gramMock!.rename("t-deps" as never, "Synthetic command preview");
    await window.gramMock!.setModel("t-deps" as never, {
      agent: fixtureProvider,
      model: fixtureProvider === "claude" ? "opus" : "gpt-5.5",
    });
  }, provider);
  const card = page.locator('[data-tool-call-id="synthetic-shell"]');
  await expect(card).toBeVisible();
  await expect(card.locator("pre")).toHaveCount(0);
  await card.getByRole("button").click();
  await expect(page.getByTestId("transcript").locator("[data-message-id]")).toHaveCount(2);
  return card;
}

for (const provider of ["claude", "codex"] as const) {
  for (const mode of ["dark", "light"] as const) {
    test(`${provider} expanded command in ${mode} preserves characters, selection and output`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1200, height: 900 });
      await seedTheme(page, {
        mode,
        palette: mode === "dark" ? "tokyo-night" : "tokyo-light",
        motion: "off",
      });
      await seed(page, provider);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const card = await open(page, provider);
      if (phase === "before") {
        await expect(card.locator("code[data-language=shellscript]")).toHaveCount(0);
        await expect(card.locator("pre").first()).toHaveText(
          provider === "claude"
            ? `$ ${command}`
            : JSON.stringify({ command, cwd: "/synthetic/project" }, null, 2),
        );
      } else {
        const code = card.locator("code[data-language=shellscript]");
        await expect(code).toHaveText(command);
        await expect(code.locator('[style*="--shiki-dark"]')).not.toHaveCount(0);
        const colors = await code
          .locator('[style*="--shiki-dark"]')
          .evaluateAll((tokens) =>
            Array.from(new Set(tokens.map((token) => getComputedStyle(token).color))),
          );
        expect(colors.length).toBeGreaterThanOrEqual(3);
        const selection = await code.evaluate((el) => {
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs inside the browser evaluation
          const select = (node: Node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            const current = window.getSelection()!;
            current.removeAllRanges();
            current.addRange(range);
            return { selected: current.toString(), source: range.toString() };
          };
          const highlighted = select(el);
          // Native selection omits a terminal newline in plain pre text too.
          const plain = el.closest("pre")!.cloneNode(false) as HTMLElement;
          plain.textContent = el.textContent;
          el.closest("pre")!.after(plain);
          const reference = select(plain);
          plain.remove();
          window.getSelection()!.removeAllRanges();
          return { highlighted, reference };
        });
        expect(selection.highlighted.source).toBe(command);
        expect(selection.highlighted.selected).toBe(selection.reference.selected);
        expect(selection.highlighted.selected).toContain(".items[] | select(. > 1)");
      }
      if (provider === "claude") {
        await expect(card.locator("pre").last()).toHaveText(stdout + stderr);
        await expect(card.locator("pre .text-destructive")).toHaveText(stderr);
      } else {
        await expect(card).toContainText('"cwd": "/synthetic/project"');
        await expect(card.locator("pre").last()).toHaveText(
          JSON.stringify({ stdout, stderr: "", interrupted: false, exitCode: 0 }, null, 2),
        );
      }
      await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `e2e/__screenshots__/command-${provider}-${mode}.${phase}.png`,
      });
      expect(errors).toEqual([]);
    });
  }
}

if (phase === "after") {
  for (const provider of ["claude", "codex"] as const) {
    test(`${provider} preserves mixed separators, quoted multiline arguments, tabs and Unicode after coloring`, async ({
      page,
    }) => {
      await seedTheme(page, { mode: "dark", palette: "tokyo-night", motion: "off" });
      const source =
        "printf 'α\t🌈\rinside'\r\nprintf '%s\\n' 'first\r\nsecond\nthird'\t| cat\r\n\n";
      await seed(page, provider, source);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const card = await open(page, provider);
      const code = card.locator("code[data-language=shellscript]");
      await expect(code.locator('[style*="--shiki-dark"]')).not.toHaveCount(0);
      const actual = await code.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { source: el.textContent, range: range.toString() };
      });
      expect(actual).toEqual({ source, range: source });
      expect(errors).toEqual([]);
    });
  }

  test("a narrow pane wraps long words; oversized commands and cancellation remain plain and readable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await seedTheme(page, { mode: "dark", palette: "tokyo-night", motion: "off" });
    const long = `printf '%s' '${"x".repeat(2200)}'\n\n`;
    await seed(page, "claude", long, "output-error");
    const card = await open(page, "claude");
    const code = card.locator("code[data-language=shellscript]");
    await expect(code).toHaveText(long);
    await expect(code.locator('[style*="--shiki-dark"]')).toHaveCount(0);
    await expect(card).toContainText("Cancelled");
    expect(await code.locator("..").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: "e2e/__screenshots__/command-narrow-fallback.after.png" });
  });

  test("a grammar load failure keeps the exact uncolored command", async ({ page }) => {
    const runtimeErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.setViewportSize({ width: 1200, height: 900 });
    await seedTheme(page, { mode: "light", palette: "tokyo-light", motion: "off" });
    await seed(page, "codex");
    const blocked: string[] = [];
    await page.route(/\/shellscript[^/?]*\.(?:js|mjs)(?:\?|$)/, (route) => {
      blocked.push(route.request().url());
      return route.abort("failed");
    });
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => /\/shellscript[^/?]*\.(?:js|mjs)(?:\?|$)/.test(request.url()),
    });
    const card = await open(page, "codex");
    await failed;
    await expect(card.locator("code[data-language=shellscript]")).toHaveText(command);
    await expect(
      card.locator('code[data-language=shellscript] [style*="--shiki-dark"]'),
    ).toHaveCount(0);
    await expect(card).toContainText('"cwd": "/synthetic/project"');
    await expect(card.locator("pre").last()).toHaveText(
      JSON.stringify({ stdout, stderr: "", interrupted: false, exitCode: 0 }, null, 2),
    );
    await page.screenshot({ path: "e2e/__screenshots__/command-load-fallback.after.png" });
    expect(runtimeErrors).toEqual([]);
    // The bundle has two shellscript chunks and the dev server one module; this fixture blocks
    // each, and each blocked load is the only error it logs.
    expect(blocked.length).toBeGreaterThan(0);
    expect(consoleErrors).toEqual(blocked.map(() => "Failed to load resource: net::ERR_FAILED"));
  });
}
