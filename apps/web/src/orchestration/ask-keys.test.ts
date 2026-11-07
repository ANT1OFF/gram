// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { plainKeysReach, types } from "./ask-keys";

// What types keeps its keys: a number pressed in it is a character, never an answer.

afterEach(() => {
  document.body.innerHTML = "";
});

const mount = (html: string): HTMLElement => {
  const area = document.createElement("div");
  area.innerHTML = html;
  document.body.append(area);
  return area;
};

describe("types", () => {
  it.each([
    ["a field", "<input id='t' />"],
    ["a text area", "<textarea id='t'></textarea>"],
    ["a select", "<select id='t'></select>"],
    ["an editing host", "<div id='t' contenteditable></div>"],
    ["a true editing host", "<div id='t' contenteditable='true'></div>"],
    ["a plaintext-only editing host", "<div id='t' contenteditable='plaintext-only'></div>"],
    [
      "what is inside a plaintext-only host",
      "<div contenteditable='plaintext-only'><p id='t'>x</p></div>",
    ],
    ["an ARIA textbox", "<div id='t' role='textbox' tabindex='0'></div>"],
    ["an ARIA searchbox", "<div id='t' role='searchbox' tabindex='0'></div>"],
  ])("holds for %s", (_, html) => {
    const area = mount(html);
    const target = area.querySelector("#t")!;
    expect(types(target)).toBe(true);
    // So a plain key pressed there never reaches an answer.
    expect(plainKeysReach(target, area)).toBe(false);
  });

  it.each([
    ["plain text", "<p id='t'>x</p>"],
    [
      "what an editing host turns off",
      "<div contenteditable='plaintext-only'><p id='t' contenteditable='false'>x</p></div>",
    ],
  ])("doesn't hold for %s", (_, html) => {
    const area = mount(html);
    const target = area.querySelector("#t")!;
    expect(types(target)).toBe(false);
    expect(plainKeysReach(target, area)).toBe(true);
  });
});
