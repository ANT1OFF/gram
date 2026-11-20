import { test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { loadUiFeatures, reach, seedMock } from "../scripts/feature-ui.mjs";

// Each feature with a `ui` block in docs/features.json is where the map says: its steps work and
// its landmark shows. `bun run drive` and agents rely on those words to find a screen, so a moved
// control fails here, not in a later driver run. Same window as the driver's default.
const features = loadUiFeatures(fileURLToPath(new URL("../../..", import.meta.url)));

test.use({ viewport: { width: 1440, height: 900 } });

for (const feature of features) {
  test(`${feature.name} is where the feature map says`, async ({ page, baseURL }) => {
    await page.addInitScript(seedMock, { scenario: feature.ui.scenario ?? "realistic" });
    await reach(page, baseURL!, feature.ui);
  });
}
