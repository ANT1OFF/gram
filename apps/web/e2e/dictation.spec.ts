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

/**
 * Binds dictation to `keys` whatever the platform's default: Right ⌥ on macOS, the chord elsewhere.
 * The chord unless a test says otherwise, so the same presses work on every runner.
 */
const withDictateKeys = (page: Page, keys = "mod+shift+space") =>
  page.addInitScript(
    ([key, value]) =>
      sessionStorage.setItem(key as string, JSON.stringify({ "composer.dictate": value })),
    ["gram.mock.keybindings", keys] as const,
  );

const withVoice = async (page: Page, on = true, voice: Record<string, unknown> = {}) => {
  await withDictateKeys(page);
  await page.addInitScript(
    ([key, voiceInput, settings]) =>
      sessionStorage.setItem(
        key as string,
        JSON.stringify({ experimental: { voiceInput }, voice: settings }),
      ),
    ["gram.mock.settings", on, voice] as const,
  );
};

/** Records the first note of each tone played, in Hz: 659 for start, 880 for stop. */
const countTones = (page: Page) =>
  page.addInitScript(() => {
    const tones: number[] = [];
    Object.assign(window, { tones });
    const start = OscillatorNode.prototype.start;
    let last = -Infinity;
    OscillatorNode.prototype.start = function (this: OscillatorNode, when?: number) {
      // A tone's two notes are made in one call: a gap means the next tone. By the page's clock, not
      // the context's, which stands still until the audio thread first runs.
      const now = performance.now();
      if (now - last > 30) tones.push(Math.round(this.frequency.value));
      last = now;
      return start.call(this, when);
    };
  });
const tones = (page: Page) => page.evaluate(() => (window as unknown as { tones: number[] }).tones);

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

test("a committed utterance spells the project's file names and the user's words their way", async ({
  page,
}) => {
  // Spoken symbols off, so the spelled names are the vocabulary's own doing, "dot" included.
  await withVoice(page, true, {
    vocabulary: [{ term: "Parakeet", soundsLike: ["para keet"] }],
    spokenSymbols: false,
  });
  const composer = await openThread(page);
  await page.evaluate(() => {
    const bridge = window.gramMock!.speechBridge;
    bridge.framesPerWord = 1;
    bridge.script = "Fix retry dot test dot ts, then ask para keet to plan the clip.";
  });
  const mic = page.getByRole("button", { name: "Start dictation" });
  await mic.click();
  const partial = page.getByTestId("dictation-partial");
  // The partial is shown as heard; only the committed text is spelled.
  await expect(partial).toContainText("plan the clip", { timeout: 15_000 * slowdown });
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(composer).toHaveValue("Fix retry.test.ts, then ask Parakeet to plan the clip.");

  // With the project's names off, only the user's own words are spelled.
  await page.evaluate(() =>
    window.gramMock!.simulateSettingsChange({ voice: { projectNames: false } }),
  );
  await composer.fill("");
  await mic.click();
  await expect(partial).toContainText("plan the clip", { timeout: 15_000 * slowdown });
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await expect(composer).toHaveValue(
    "Fix retry dot test dot ts, then ask Parakeet to plan the clip.",
  );
});

/** Counts each opening of the microphone, and how many of its tracks are still running. */
const countMicrophone = (page: Page) =>
  page.addInitScript(() => {
    const mic = { opened: 0, tracks: [] as MediaStreamTrack[] };
    Object.assign(window, { mic });
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      mic.opened += 1;
      const stream = await open(constraints);
      mic.tracks.push(...stream.getTracks());
      return stream;
    };
  });
const microphone = (page: Page) =>
  page.evaluate(() => {
    const { mic } = window as unknown as {
      mic: { opened: number; tracks: MediaStreamTrack[] };
    };
    return {
      opened: mic.opened,
      running: mic.tracks.filter((track) => track.readyState === "live").length,
    };
  });

test("the microphone opens on a press and closes with its stop, never on focus", async ({
  page,
}) => {
  await withVoice(page);
  await countMicrophone(page);
  const composer = await openThread(page);
  await page.getByRole("button", { name: "Start dictation" }).waitFor();
  await composer.focus();
  await page.waitForTimeout(500 * slowdown);
  expect(await microphone(page)).toEqual({ opened: 0, running: 0 });

  await composer.press("ControlOrMeta+Shift+Space");
  await expect(page.getByTestId("dictation-partial")).toContainText("Refactor");
  expect(await microphone(page)).toEqual({ opened: 1, running: 1 });
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  await expect.poll(() => microphone(page)).toEqual({ opened: 1, running: 0 });
});

test("Keep microphone ready holds it from focus, hands a press what it heard, and turns off at once", async ({
  page,
}) => {
  await withDictateKeys(page);
  await page.addInitScript(
    ([key]) =>
      sessionStorage.setItem(
        key as string,
        JSON.stringify({
          experimental: { voiceInput: true },
          voice: { keepMicrophoneReady: true },
        }),
      ),
    ["gram.mock.settings"] as const,
  );
  await countMicrophone(page);
  const composer = await openThread(page);
  await page.getByRole("button", { name: "Start dictation" }).waitFor();
  await composer.focus();
  await expect.poll(() => microphone(page)).toEqual({ opened: 1, running: 1 });
  await page.waitForTimeout(700 * slowdown);

  await composer.press("ControlOrMeta+Shift+Space");
  // The lead silence and at least the pre-roll, there before any frame could have been captured.
  await expect
    .poll(() => page.evaluate(() => window.gramMock!.speechBridge.framesHeard))
    .toBeGreaterThanOrEqual(3 + 4);
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  // Still the one stream, held for the next press.
  expect(await microphone(page)).toEqual({ opened: 1, running: 1 });

  // Inside the app: a reload would drop the microphone by itself.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsNav(page).getByRole("link", { name: "Voice", exact: true }).click();
  await expect(page.getByTestId("voice-input-settings")).toContainText(
    "microphone indicator stays lit",
  );
  const keep = page.getByRole("switch", { name: "Keep microphone ready" });
  await expect(keep).toBeChecked();
  await keep.click();
  await expect.poll(() => microphone(page)).toEqual({ opened: 1, running: 0 });
});

test("holding Right ⌥ talks from anywhere in the window, with a tone at each end", async ({
  page,
}) => {
  await withVoice(page);
  await withDictateKeys(page, "altright");
  await countTones(page);
  const composer = await openThread(page);
  await composer.fill("Draft");
  await page.getByRole("button", { name: "Start dictation" }).waitFor();
  // Away from the composer: nothing in its pane has the focus.
  await composer.evaluate((field) => (field as HTMLTextAreaElement).blur());
  await expect(composer).not.toBeFocused();

  await page.keyboard.down("AltRight");
  await expect(page.getByTestId("dictation-partial")).toContainText("Refactor the model");
  await expect(composer).toBeFocused();
  await expect.poll(() => tones(page)).toEqual([659]);
  await page.keyboard.up("AltRight");
  await expect(composer).toHaveValue(/^Draft Refactor the model/);
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();
  expect(await tones(page)).toEqual([659, 880]);
});

test("a tap of Right ⌥, or ⌥ with another key, throws dictation away without a sound", async ({
  page,
}) => {
  // With the microphone ready, capture is live well inside a tap: only the tap rule keeps it quiet.
  await withVoice(page, true, { keepMicrophoneReady: true });
  await withDictateKeys(page, "altright");
  await countTones(page);
  const composer = await openThread(page);
  await composer.fill("Draft");
  await composer.focus();
  await page.waitForTimeout(500 * slowdown);
  await page.keyboard.down("AltRight");
  // Up as soon as a word is heard, which a hold would commit. Checked each frame: `expect.poll`'s
  // 100 ms steps plus a fixed wait made the press about 300 ms on CI, a hold as often as a tap.
  await page.waitForFunction(
    () => {
      const bridge = window.gramMock!.speechBridge;
      return bridge.framesHeard >= bridge.framesPerWord;
    },
    undefined,
    { polling: "raf" },
  );
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(800 * slowdown);
  await expect(composer).toHaveValue("Draft");
  await expect(page.getByRole("button", { name: "Start dictation" })).toBeVisible();

  // A key with it makes a shortcut, not dictation. ⌥↑ moves the caret on every platform; ⌥← is the
  // browser's Back off macOS.
  await composer.press("End");
  await page.keyboard.down("AltRight");
  await page.waitForTimeout(100);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(600 * slowdown);
  await page.keyboard.up("AltRight");
  await expect(composer).toHaveValue("Draft");
  await expect(page.getByTestId("dictation-partial")).toHaveCount(0);
  expect(await tones(page)).toEqual([]);
});

test("a double tap of Right ⌥ keeps listening until the next press; Sounds off stays quiet", async ({
  page,
}) => {
  await withVoice(page, true, { sounds: false });
  await withDictateKeys(page, "altright");
  await countTones(page);
  const composer = await openThread(page);
  await page.getByRole("button", { name: "Start dictation" }).waitFor();
  await composer.focus();
  await page.keyboard.press("AltRight");
  await page.keyboard.press("AltRight");
  await expect(page.getByTestId("dictation-partial")).toContainText("Refactor the model");
  await expect(page.getByTestId("composer-toolbar")).toContainText("Listening");
  await page.keyboard.press("AltRight");
  await expect(composer).toHaveValue(/^Refactor the model/);
  expect(await tones(page)).toEqual([]);

  // The key and the sound settings, where they're changed.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsNav(page).getByRole("link", { name: "Voice", exact: true }).click();
  const section = page.getByTestId("voice-input-settings");
  await expect(section.getByTestId("dictate-key")).toHaveText(/^Right (⌥|Alt)$/);
  await expect(section.getByRole("switch", { name: "Sounds" })).not.toBeChecked();
  await expect(section.getByTestId("dictation-sound-volume")).toHaveCount(0);
  await section.getByRole("switch", { name: "Sounds" }).click();
  await expect(section.getByTestId("dictation-sound-volume")).toBeVisible();
  expect(await tones(page)).toEqual([659]);
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

test("what commits is cleaned up, the live partial never, and Settings turns each rule off", async ({
  page,
}) => {
  await withVoice(page);
  const composer = await openThread(page);
  await page.evaluate(() => {
    window.gramMock!.speechBridge.script = "Um, rename foo underscore bar new line done";
  });
  await composer.fill("");
  await composer.focus();
  await composer.press("ControlOrMeta+Shift+Space");
  const partial = page.getByTestId("dictation-partial");
  // The words at the caret are as heard; only what commits is tidied.
  await expect(partial).toHaveText("Um, rename foo underscore bar new line done");
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(composer).toHaveValue("Rename foo_bar\ndone");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsNav(page).getByRole("link", { name: "Voice", exact: true }).click();
  const section = page.getByTestId("voice-input-settings");
  for (const name of ["Remove filler words", "Spoken formatting", "Spoken symbols"])
    await expect(section.getByRole("switch", { name })).toBeChecked();
  await section.getByRole("switch", { name: "Spoken symbols" }).click();
  await expect(section.getByRole("switch", { name: "Spoken symbols" })).not.toBeChecked();

  // Settings keeps the overview's column for its Back strip; the threads are a step out.
  await page.getByTestId("settings-back").click();
  await threadRow(page, "t-deps").click();
  await composer.fill("");
  await composer.focus();
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(partial).toHaveText("Um, rename foo underscore bar new line done");
  await composer.press("ControlOrMeta+Shift+Space");
  await expect(composer).toHaveValue("Rename foo underscore bar\ndone");
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

test("Settings: Voice is a page of its own, off until on, with the size and licence before the download", async ({
  page,
}) => {
  await withVoice(page, false);
  // Off, the page is listed all the same, with the switch at the top and nothing else.
  await page.goto("/settings/general");
  await settingsNav(page).getByRole("link", { name: "Voice", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/voice-input$/);
  const section = page.getByTestId("voice-input-settings");
  const toggle = section.getByRole("switch", { name: "Voice input" });
  await expect(toggle).not.toBeChecked();
  await expect(section).not.toContainText("Experimental");
  await expect(section.getByTestId("dictate-key")).toHaveCount(0);

  await toggle.click();
  const notice = page.getByTestId("voice-input-notice");
  await expect(notice).toContainText("662 MB");
  await expect(notice).toContainText("NVIDIA Open Model License");
  await expect(notice).toContainText("Licensed by NVIDIA Corporation");
  await expect(notice).toContainText("Creative Commons Attribution 4.0");
  await expect(notice).toContainText("Parakeet TDT 0.6B v2 by NVIDIA, licensed under CC BY 4.0");
  await expect(notice).toContainText("Silero VAD, copyright (c) 2020-present Silero Team");
  // Not now leaves it off, with nothing fetched.
  await notice.getByRole("button", { name: "Not now" }).click();
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await page.getByRole("button", { name: "Download 1.3 GB" }).click();
  await expect(toggle).toBeChecked();
  await expect(section.getByTestId("dictate-key")).toBeVisible();
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
  // Settings keeps the overview's column for its Back strip; the threads are a step out.
  await page.getByTestId("settings-back").click();
  await threadRow(page, "t-deps").click();
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.speechBridge.loads.at(-1)))
    .toEqual([EFFICIENT, "efficient"]);
});

test("Settings: Accurate asks before downloading its models, and Live needs none of them", async ({
  page,
}) => {
  await withVoice(page);
  await page.goto("/settings/voice-input");
  const section = page.getByTestId("voice-input-settings");
  await expect(section).toBeVisible();
  await page.evaluate(() => window.gramMock!.speech.preinstall());
  const mode = section.getByRole("radiogroup", { name: "Transcription" });
  await expect(mode.getByRole("radio", { name: "Accurate" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(section).toContainText("Dictation stays Live until then.");

  // Nothing downloads before the licences are on screen; Not now fetches nothing.
  await section.getByTestId("voice-accurate-download").click();
  const notice = page.getByTestId("voice-accurate-notice");
  await expect(notice).toContainText("Creative Commons Attribution 4.0");
  await expect(notice).toContainText("Parakeet TDT 0.6B v2 by NVIDIA, licensed under CC BY 4.0");
  await expect(notice).toContainText("MIT License");
  await notice.getByRole("button", { name: "Not now" }).click();
  await expect(section).toContainText("aren't downloaded");

  await section.getByTestId("voice-accurate-download").click();
  await page
    .getByTestId("voice-accurate-notice")
    .getByRole("button", { name: /Download/ })
    .click();
  await expect(section.getByTestId("voice-accurate-ready")).toBeVisible();
  await expect(section).toContainText("CC BY 4.0");

  await mode.getByRole("radio", { name: "Live" }).click();
  await expect(section.getByTestId("voice-accurate-ready")).toHaveCount(0);
  await mode.getByRole("radio", { name: "Accurate" }).click();

  // Sessions ask for the mode; the shell decides whether it can run it.
  // Settings keeps the overview's column for its Back strip; the threads are a step out.
  await page.getByTestId("settings-back").click();
  await threadRow(page, "t-deps").click();
  await page.getByRole("button", { name: "Start dictation" }).click();
  await expect
    .poll(() => page.evaluate(() => window.gramMock?.speechBridge.modes.at(-1)))
    .toBe("accurate");
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

test("Settings: the push-to-talk key takes a modifier held alone or a chord, as Keyboard's binding", async ({
  page,
}) => {
  await withVoice(page);
  await page.goto("/settings/voice-input");
  const section = page.getByTestId("voice-input-settings");
  const key = section.getByTestId("dictate-key");
  await expect(key).toHaveText(/^(⌘⇧Space|Ctrl\+Shift\+Space)$/);
  await expect(section).toContainText("Push-to-talk key");

  // A modifier held alone, recorded as it comes up.
  await section.getByRole("button", { name: "Change…" }).click();
  const dialog = page.getByTestId("key-capture-dialog");
  await page.keyboard.press("ControlRight");
  await expect(dialog.getByTestId("key-capture-status")).toHaveText(/^Recorded Right (⌃|Ctrl)\.$/);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(key).toHaveText(/^Right (⌃|Ctrl)$/);

  // The one binding: Settings → Keyboard shows what the Voice page set.
  await openAdvancedPage(page, "Keyboard");
  await expect(page.getByTestId("binding-composer.dictate").locator("kbd")).toHaveText(
    /^Right (⌃|Ctrl)$/,
  );

  // A chord another shortcut has is named, and Replace takes it.
  await settingsNav(page).getByRole("link", { name: "Voice", exact: true }).click();
  await section.getByRole("button", { name: "Change…" }).click();
  await page.keyboard.press("ControlOrMeta+l");
  await expect(dialog.getByTestId("key-capture-clash")).toContainText(
    "Same keys as Focus composer",
  );
  await dialog.getByRole("button", { name: "Replace" }).click();
  await expect(key).toHaveText(/^(⌘L|Ctrl\+L)$/);

  // Escape leaves it as it was; the reset puts the platform's default back.
  await section.getByRole("button", { name: "Change…" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(key).toHaveText(/^(⌘L|Ctrl\+L)$/);
  await section.getByRole("button", { name: "Reset Push-to-talk key to default" }).click();
  await expect(key).toHaveText(/^(Right ⌥|Ctrl\+Shift\+Space)$/);
});
