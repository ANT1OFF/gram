import type { Page } from "@playwright/test";

declare global {
  interface Window {
    gramFlashes?: string[];
  }
}

/**
 * Records the text of every element that gets `data-flash="true"`, from before the app loads. A flash
 * lasts 1.6 s, which a slow runner can spend between two polls, so specs check the record rather
 * than the live attribute.
 */
export async function recordFlashes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const flashes: string[] = [];
    window.gramFlashes = flashes;
    const note = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.getAttribute("data-flash") === "true") flashes.push(node.textContent ?? "");
      for (const flashed of node.querySelectorAll('[data-flash="true"]')) {
        flashes.push(flashed.textContent ?? "");
      }
    };
    const observe = () =>
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes") note(mutation.target);
          else mutation.addedNodes.forEach(note);
        }
      }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-flash"],
      });
    if (document.documentElement) observe();
    else document.addEventListener("DOMContentLoaded", observe, { once: true });
  });
}

/** What `recordFlashes` has seen flash so far. */
export const flashedTexts = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.gramFlashes ?? []);
