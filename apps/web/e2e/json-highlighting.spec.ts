import { expect, test, type Page } from "@playwright/test";
import { seedTheme } from "./seed-theme";
const command = "printf synthetic\n";
const stdout =
  ' \t{\r\n\t"nested": [true, null, {"html": "<script>α🌈</script>", "escaped": "\\t\\n"}]\n} \r\n\n';
const stderr = '{"error":"synthetic"}\n';
const phase = process.env["GRAM_JSON_SHOTS_PHASE"] ?? "after";
if (phase !== "before" && phase !== "after") throw new Error(`Unknown phase: ${phase}`);
async function seed(
  page: Page,
  provider: "claude" | "codex",
  text = command,
  state = "output-available",
  output = stdout,
  preliminary = false,
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
              preliminary: fixture.preliminary,
              input: {
                command: fixture.text,
                ...(fixture.provider === "codex"
                  ? { cwd: "/synthetic/project" }
                  : { description: "Filter a synthetic JSON array" }),
              },
              ...(fixture.state === "output-error"
                ? { errorText: "Cancelled" }
                : {
                    output:
                      fixture.provider === "claude"
                        ? { stdout: fixture.stdout, stderr: fixture.stderr, interrupted: true }
                        : fixture.stdout,
                  }),
              providerExecuted: true,
            },
            {
              ...(fixture.provider === "claude"
                ? { type: "tool-json_probe" }
                : { type: "dynamic-tool", toolName: "json_probe" }),
              toolCallId: "synthetic-structured",
              state: "output-available",
              input: { nested: [null, true, { html: "<em>α🌈</em>", escaped: "\t\n" }] },
              output: { nested: { values: [1, false, null], label: "synthetic" } },
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
    { provider, text, state, stdout: output, stderr, preliminary },
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
  await page.getByTestId("tool-group").locator(":scope > button").click();
  const card = page.locator('[data-tool-call-id="synthetic-shell"]');
  await expect(card).toBeVisible();
  await expect(card.locator("pre")).toHaveCount(0);
  await card.getByRole("button").click();
  await expect(page.getByTestId("transcript").locator("[data-message-id]")).toHaveCount(2);
  return card;
}

for (const provider of ["claude", "codex"] as const) {
  for (const mode of ["light", "dark"] as const) {
    for (const narrow of [false, true]) {
      test(`${provider} JSON ${mode} ${narrow ? "narrow" : "wide"}: exact source, selection, copy and structured tokens`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: narrow ? 640 : 1200, height: 900 });
        await seedTheme(page, {
          mode,
          palette: mode === "dark" ? "tokyo-night" : "tokyo-light",
          motion: "off",
        });
        await seed(page, provider);
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        const card = await open(page, provider);
        const structured = page.locator('[data-tool-call-id="synthetic-structured"]');
        await structured.getByRole("button").click();
        const output = card.locator("pre").last();
        expect(await output.textContent()).toBe(stdout + (provider === "claude" ? stderr : ""));
        if (phase === "after") {
          const json = card.locator('code[data-language="json"]').last();
          await expect(json.locator('[style*="--shiki-dark"]')).not.toHaveCount(0);
          const values = await json.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            const selected = selection.toString();
            const plain = el.closest("pre")!.cloneNode(false) as HTMLElement;
            plain.id = "synthetic-reference";
            const originalText = document.createTextNode(el.textContent!);
            plain.append(originalText);
            // Match the old stdout text node plus adjacent stderr, including its terminal-newline behavior.
            for (let sibling = el.nextSibling; sibling; sibling = sibling.nextSibling)
              plain.append(sibling.cloneNode(true));
            el.closest("pre")!.after(plain);
            const reference = document.createRange();
            reference.selectNodeContents(originalText);
            selection.removeAllRanges();
            selection.addRange(reference);
            const expected = selection.toString();
            selection.removeAllRanges();
            selection.addRange(range);
            return { source: el.textContent, range: range.toString(), selected, expected };
          });
          expect(values.source).toBe(stdout);
          expect(values.range).toBe(stdout);
          expect(values.selected).toBe(values.expected);
          // Native copy/paste in the owned browser; no clipboard permission grant.
          await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
          await page.evaluate(() => {
            const paste = document.createElement("textarea");
            paste.id = "synthetic-paste";
            document.body.append(paste);
            paste.focus();
          });
          await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
          const copied = await page.locator("#synthetic-paste").inputValue();
          await page.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector("#synthetic-reference")!.firstChild!);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
          });
          await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
          await page.locator("#synthetic-paste").fill("");
          await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
          // A textarea normalizes CRLF on paste; compare native copies of both DOM representations.
          await expect(page.locator("#synthetic-paste")).toHaveValue(copied);
          expect(copied).toContain('"nested": [true, null');
          await page.locator("#synthetic-reference").evaluate((el) => el.remove());
          await page.locator("#synthetic-paste").evaluate((el) => el.remove());
          const colors = await json
            .locator('[style*="--shiki-dark"]')
            .evaluateAll((tokens) =>
              Array.from(new Set(tokens.map((t) => getComputedStyle(t).color))),
            );
          expect(colors.length).toBeGreaterThanOrEqual(3);
          await expect(structured.locator('code[data-language="json"]')).toHaveCount(2);
          for (const code of await structured.locator('code[data-language="json"]').all())
            await expect(code.locator('[style*="--shiki-dark"]')).not.toHaveCount(0);
        } else {
          await expect(page.locator('code[data-language="json"]')).toHaveCount(0);
        }
        if (provider === "claude") {
          await expect(card.locator(".text-destructive")).toHaveText(stderr);
          await expect(card.locator(".text-destructive code")).toHaveCount(0);
          await expect(card).toContainText("Interrupted");
        } else await expect(card).toContainText('"cwd": "/synthetic/project"');
        await expect(card.locator("script")).toHaveCount(0);
        await expect(structured.locator("em")).toHaveCount(0);
        await page.screenshot({
          path: `e2e/__screenshots__/json-${provider}-${mode}-${narrow ? "narrow" : "wide"}.${phase}.png`,
        });
        expect(errors).toEqual([]);
      });
    }
  }
}
if (phase === "after")
  test("JSON grammar load failure retains original source and diagnostic stderr", async ({
    page,
  }) => {
    await seedTheme(page, { mode: "dark", palette: "tokyo-night", motion: "off" });
    await seed(page, "claude");
    await page.route(/\/json[^/?]*\.(?:js|mjs)(?:\?|$)/, (route) => route.abort("failed"));
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => /\/json[^/?]*\.(?:js|mjs)(?:\?|$)/.test(request.url()),
    });
    const card = await open(page, "claude");
    await failed;
    const json = card.locator('code[data-language="json"]');
    expect(await json.textContent()).toBe(stdout);
    await expect(json.locator('[style*="--shiki-dark"]')).toHaveCount(0);
    expect(await card.locator("pre").last().textContent()).toBe(stdout + stderr);
  });

if (phase === "after") {
  for (const provider of ["claude", "codex"] as const) {
    for (const [label, text, preliminary] of [
      ["plain/malformed", 'log {"partial":', false],
      ["oversized line", '{"large":"' + "x".repeat(2049) + '"}', false],
      ["preliminary valid JSON", '{"still":"streaming"}', true],
    ] as const) {
      test(`${provider} ${label} stays plain`, async ({ page }) => {
        await seedTheme(page, { mode: "dark", palette: "tokyo-night", motion: "off" });
        await seed(page, provider, command, "output-available", text, preliminary);
        const card = await open(page, provider);
        expect(await card.locator("pre").last().textContent()).toBe(
          text + (provider === "claude" ? stderr : ""),
        );
        await expect(card.locator("pre").last().locator('code[data-language="json"]')).toHaveCount(
          0,
        );
      });
    }
  }
}
