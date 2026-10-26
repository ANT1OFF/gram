import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";

import { openAdvancedPage, settingsNav } from "./settings-nav";
import { threadRow } from "./thread-row";

// Chromium's fake microphone, granted without a prompt, so the real capture worklet runs and feeds
// the mock speech process, which "hears" its script a word every two frames.
test.use({
  launchOptions: {
    ...(process.env["GRAM_E2E_CHROMIUM"]
      ? { executablePath: process.env["GRAM_E2E_CHROMIUM"] }
      : {}),
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

const HEARD = "Refactor the model store so it resumes downloads.";

const withVoice = (page: Page, on = true) =>
  page.addInitScript(
    ([key, voiceInput]) =>
      sessionStorage.setItem(key as string, JSON.stringify({ experimental: { voiceInput } })),
    ["gram.mock.settings", on] as const,
  );

const openThread = async (page: Page, installed = true) => {
  await page.goto("/t/t-deps");
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeVisible();
  if (installed) await page.evaluate(() => window.gramMock?.speech.preinstall());
  return composer;
};

test("the mic dictates into the draft at the caret, and Escape throws the partial away", async ({
  page,
}) => {
  await withVoice(page);
  const composer = await openThread(page);
  await composer.fill("Fix the flaky test");
  const mic = page.getByRole("button", { name: "Start dictation" });

  await mic.click();
  const stop = page.getByRole("button", { name: "Stop dictation" });
  await expect(stop).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("composer-toolbar")).toContainText("Listening");
  const partial = page.getByTestId("dictation-partial");
  await expect(partial).toContainText("Refactor the model");
  // Shown, not typed: the draft is what it was.
  await expect(composer).toHaveValue("Fix the flaky test");

  // Escape works from the mic button too, which keeps the focus after a click.
  await expect(stop).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(partial).toHaveCount(0);
  await expect(composer).toHaveValue("Fix the flaky test");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await composer.focus();

  // The shortcut starts and stops it; stopping commits what was heard, after a space.
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(partial).toHaveText(` ${HEARD}`);
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(composer).toHaveValue(`Fix the flaky test ${HEARD}`);
  await expect(partial).toHaveCount(0);
  await expect(page.getByTestId("pane-status")).not.toHaveText("Running");

  // One ⌘Z takes the dictated text back, as typing would.
  await composer.press("ControlOrMeta+z");
  await expect(composer).toHaveValue("Fix the flaky test");
});

test("an empty draft's placeholder gives way to the partial, and comes back after", async ({
  page,
}) => {
  await withVoice(page);
  const composer = await openThread(page);
  await expect(composer).toHaveAttribute("placeholder", /^Message…/);
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(composer).toHaveAttribute("placeholder", "");
  await expect(page.getByTestId("dictation-partial")).toContainText("Refactor the");
  await expect(composer).toHaveAttribute("placeholder", "");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dictation-partial")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(composer).toHaveAttribute("placeholder", /^Message…/);
});

test("typing while dictating keeps what was heard and stops listening", async ({ page }) => {
  await withVoice(page);
  const composer = await openThread(page);
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(page.getByTestId("dictation-partial")).toContainText("Refactor the");
  await composer.press("End");
  await page.keyboard.type("!");
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  await expect(composer).toHaveValue(/^! Refactor the/);
});

test("a partial too long for its line keeps the words just said in view", async ({ page }) => {
  await withVoice(page);
  const composer = await openThread(page);
  await page.evaluate(() => {
    const bridge = window.gramMock!.speechBridge;
    bridge.framesPerWord = 1;
    bridge.script = `${"and then a little more ".repeat(8)}lastword`;
  });
  await composer.fill("Draft");
  await composer.press("Home");
  await page.getByRole("button", { name: "Start dictation" }).click();
  const strip = page.getByTestId("dictation-partial");
  await expect(strip).toContainText("lastword", { timeout: 15_000 * slowdown });
  const inView = await strip.evaluate((element) => {
    const text = element.firstElementChild!.firstChild!;
    const range = document.createRange();
    const at = text.textContent!.lastIndexOf("lastword");
    range.setStart(text, at);
    range.setEnd(text, at + "lastword".length);
    const word = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return word.left >= box.left && word.right <= box.right + 1;
  });
  expect(inView).toBe(true);
});

test("the /new and /new-task drafts dictate the same way, with no thread yet", async ({ page }) => {
  await withVoice(page);
  await page.goto("/new");
  const prompt = page.getByLabel("First prompt");
  await expect(prompt).toBeVisible();
  await page.evaluate(() => window.gramMock?.speech.preinstall());
  await expect(prompt).toHaveAttribute("placeholder", /^Describe the task/);
  await prompt.fill("Draft");

  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(prompt).toHaveAttribute("placeholder", "");
  await expect(page.getByTestId("draft-dictation-status")).toHaveText("Listening… Esc discards");
  const partial = page.getByTestId("dictation-partial");
  await expect(partial).toContainText("Refactor the model");
  await expect(page.getByRole("button", { name: "Stop dictation" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(partial).toHaveCount(0);
  await expect(prompt).toHaveValue("Draft");
  await expect(prompt).toHaveAttribute("placeholder", /^Describe the task/);
  await expect(page.getByTestId("draft-dictation-status")).toHaveText("");

  // The shortcut commits what was heard into the draft, which is never created on its own.
  await prompt.focus();
  await prompt.press("ControlOrMeta+Shift+Space");
  await expect(partial).toHaveText(` ${HEARD}`);
  await prompt.press("ControlOrMeta+Shift+Space");
  await expect(prompt).toHaveValue(`Draft ${HEARD}`);
  await expect(page).toHaveURL(/\/new$/);

  await page.goto("/new-task");
  const task = page.getByLabel("What needs doing");
  // The shortcut answers once settings have loaded and the mic shows; the mock is there by then.
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  await page.evaluate(() => window.gramMock!.speech.preinstall());
  await task.fill("");
  await task.press("ControlOrMeta+Shift+Space");
  await expect(page.getByTestId("dictation-partial")).toContainText("Refactor");
  // Sending mid-utterance stops instead, and the words land in the draft that is still here.
  await task.press("ControlOrMeta+Enter");
  await expect(task).toHaveValue(/^Refactor/);
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  await expect(page).toHaveURL(/\/new-task$/);
  await task.fill("");
  await task.focus();
  await task.press("ControlOrMeta+Shift+Space");
  await expect(task).toHaveAttribute("placeholder", "");
  await expect(page.getByTestId("dictation-partial")).toHaveText(HEARD);
  await task.press("ControlOrMeta+Shift+Space");
  await expect(task).toHaveValue(HEARD);
  await expect(page).toHaveURL(/\/new-task$/);
});

test("says why it can't start: no model yet, or no microphone permission", async ({ page }) => {
  await withVoice(page);
  await openThread(page, false);
  await page.getByRole("button", { name: "Start dictation" }).click();
  const error = page.getByRole("alert").filter({ hasText: "Dictation:" });
  await expect(error).toContainText("The speech model isn't downloaded yet");
  await expect(page.getByTestId("dictation-button")).toHaveAttribute("data-state", "error");
  // The old toolbar hint disappeared after 2.5 seconds; the full error stays until dismissed.
  await page.waitForTimeout(3_000 * slowdown);
  await expect(error).toBeVisible();
  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.fill("Keep this draft");
  await composer.press("Escape");
  await expect(error).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this draft");

  await page.evaluate(() => {
    window.gramMock?.speech.preinstall();
    if (window.gramMock) window.gramMock.speechBridge.access = "denied";
  });
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect(error).toContainText("Microphone access is off");
});

test("with voice input off there is no mic and no shortcut", async ({ page }) => {
  await withVoice(page, false);
  const composer = await openThread(page);
  await expect(page.getByTestId("composer-toolbar")).toBeVisible();
  await expect(page.getByTestId("dictation-button")).toHaveCount(0);
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(page.getByTestId("dictation-partial")).toHaveCount(0);
});

const holdDictate = async (page: Page) => {
  await page.keyboard.down("ControlOrMeta");
  await page.keyboard.down("Shift");
  await page.keyboard.down("Space");
  const at = Date.now();
  return async () => {
    await page.waitForTimeout(Math.max(0, at + 400 - Date.now()));
    await page.keyboard.up("Space");
    await page.keyboard.up("Shift");
    await page.keyboard.up("ControlOrMeta");
  };
};

test("holding the shortcut talks until it's let go; key repeat, Escape and a blur while held", async ({
  page,
}) => {
  await withVoice(page);
  const composer = await openThread(page);
  await composer.focus();
  const partial = page.getByTestId("dictation-partial");
  const mic = page.getByTestId("dictation-button");

  // Held: listening, through the OS's key repeat, until the keys come up; then it commits.
  let release = await holdDictate(page);
  await expect(partial).toContainText("Refactor the");
  for (let i = 0; i < 3; i++) await page.keyboard.down("Space");
  await expect(mic).toHaveAttribute("data-state", "listening");
  await release();
  await expect(composer).toHaveValue(/^Refactor the/);
  await expect(mic).toHaveAttribute("data-state", "idle");
  await expect(partial).toHaveCount(0);

  // A tap still toggles: it keeps listening after the keys come up.
  await composer.fill("");
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(partial).toContainText("Refactor");
  await expect(mic).toHaveAttribute("data-state", "listening");
  await page.keyboard.press("Escape");
  await expect(mic).toHaveAttribute("data-state", "idle");

  // Escape while held discards, and letting go afterwards starts nothing.
  release = await holdDictate(page);
  await expect(partial).toContainText("Refactor");
  await page.keyboard.press("Escape");
  await expect(partial).toHaveCount(0);
  await release();
  await expect(composer).toHaveValue("");
  await expect(mic).toHaveAttribute("data-state", "idle");

  // The window losing the focus while held stops, keeping what was heard.
  release = await holdDictate(page);
  await expect(partial).toContainText("Refactor");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(composer).toHaveValue(/^Refactor/);
  await expect(mic).toHaveAttribute("data-state", "idle");
  await release();
  await expect(mic).toHaveAttribute("data-state", "idle");

  await expect(mic).toHaveAttribute("aria-label", "Start dictation");
  await mic.hover();
  // The tooltip says a hold talks, as the shortcut list does.
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    /^Start dictation \((?:⌘⇧|Ctrl\+Shift\+)Space, or hold it to talk\)$/,
  );
});

const MODEL = "nemotron-speech-en-0.6b-560ms-int8";
const EFFICIENT = "nemotron-speech-en-0.6b-1120ms-int8";

test("Settings: experimental until on, then the size and licence before the download", async ({
  page,
}) => {
  await withVoice(page, false);
  // Off, the page isn't listed and a link to it opens Diagnostics, whose Experimental group has
  // the switch.
  await page.goto("/settings/voice-input");
  await expect(page).toHaveURL(/\/settings\/diagnostics$/);
  await settingsNav(page).getByRole("link", { name: "Advanced", exact: true }).click();
  const rows = page.getByTestId("settings-subpages");
  await expect(rows.getByRole("link", { name: "Diagnostics" })).toBeVisible();
  await expect(rows.getByRole("link", { name: "Voice input" })).toHaveCount(0);
  await rows.getByRole("link", { name: "Diagnostics" }).click();
  const toggle = page.getByTestId("diagnostics").getByRole("switch", { name: "Voice input" });
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  const notice = page.getByTestId("voice-input-notice");
  await expect(notice).toContainText("662 MB");
  await expect(notice).toContainText("NVIDIA Open Model License");
  await expect(notice).toContainText("Licensed by NVIDIA Corporation");
  // Not now leaves it off, with nothing fetched.
  await notice.getByRole("button", { name: "Not now" }).click();
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await page.getByRole("button", { name: "Download 662 MB" }).click();
  await expect(toggle).toBeChecked();
  await openAdvancedPage(page, "Voice input");
  const section = page.getByTestId("voice-input-settings");
  await expect(section.getByTestId("voice-model-ready")).toBeVisible();

  // A failed download says why, and resumes from what it kept.
  await page.evaluate(async (model) => {
    const mock = window.gramMock!;
    await mock.removeSpeechModel(model as never);
    mock.speech.failNext = { reason: "proxy", message: "Ask for huggingface.co to be allowed." };
    await mock.installSpeechModel(model as never);
  }, MODEL);
  await expect(section.getByTestId("voice-model-failed")).toContainText(
    "A proxy or firewall blocked the download",
  );
  await section.getByRole("button", { name: "Resume" }).click();
  await expect(section.getByTestId("voice-model-ready")).toBeVisible();
});

test("Settings: the slider's stops say what they cost, and a new stop's model replaces the old", async ({
  page,
}) => {
  await withVoice(page);
  await page.goto("/settings/voice-input");
  await expect(page.getByTestId("voice-input-settings")).toBeVisible();
  await page.evaluate(() => window.gramMock!.speech.preinstall());
  const slider = page.getByRole("slider", { name: "Responsiveness" });
  const help = page.getByTestId("voice-performance-help");
  await expect(slider).toHaveAttribute("aria-valuetext", "Balanced");
  await expect(help).toContainText("about every 0.6 s");
  await expect(help).toContainText("Accuracy is the same at every setting.");
  await expect(help).not.toContainText("Needs a");

  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", "Efficient");
  await expect(help).toContainText("an eighth of one core");
  await expect(help).toContainText("Needs a 662 MB download.");
  const section = page.getByTestId("voice-input-settings");
  await expect(section).toContainText("Dictation uses the Balanced model until then.");
  await section.getByRole("button", { name: "Download 662 MB" }).click();
  await expect(section.getByTestId("voice-model-ready")).toBeVisible();
  await expect(help).not.toContainText("Needs a");
  // Only the new stop's model stays on disk.
  await expect
    .poll(() =>
      page.evaluate(async (model) => {
        const status = await window.gramMock!.speechStatus(model as never);
        return status.installed !== undefined;
      }, MODEL),
    )
    .toBe(false);

  // Dictation then runs at that stop. In-app, since a reload would start the mock afresh.
  await threadRow(page, "t-deps").click();
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.speechBridge.loads.at(-1)))
    .toEqual([EFFICIENT, "efficient"]);
});

test("Settings: turning voice input off says what it frees, deletes the model and stops the process", async ({
  page,
}) => {
  await withVoice(page);
  await page.goto("/settings/voice-input");
  await expect(page.getByTestId("voice-input-settings")).toBeVisible();
  await page.evaluate(() => window.gramMock!.speech.preinstall());
  const section = page.getByTestId("voice-input-settings");
  await expect(section.getByTestId("voice-model-ready")).toBeVisible();
  await section.getByRole("switch", { name: "Voice input" }).click();
  const confirm = page.getByTestId("voice-input-off");
  await expect(confirm).toContainText("freeing 662 MB");
  await confirm.getByRole("button", { name: "Turn off and delete" }).click();
  await expect(section.getByRole("switch", { name: "Voice input" })).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(async (model) => {
        const mock = window.gramMock!;
        return [(await mock.speechStatus(model as never)).installed, mock.speechBridge.shutdowns];
      }, MODEL),
    )
    .toEqual([undefined, 1]);
});

test("Settings: microphone access that's off says where to turn it on", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({ experimental: { voiceInput: true } }),
    );
  });
  await page.goto("/settings/voice-input");
  const section = page.getByTestId("voice-input-settings");
  await expect(section).toContainText("Allowed");
  await page.evaluate(() => {
    window.gramMock!.speechBridge.access = "denied";
    // As the window coming back from System Settings does.
    window.dispatchEvent(new Event("focus"));
  });
  await expect(section).toContainText("Not allowed");
  await expect(section.getByRole("button", { name: "Open System Settings" })).toBeVisible();
});
