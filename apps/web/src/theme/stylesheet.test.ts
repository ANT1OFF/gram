import { generateStylesheet } from "@gram/themes";
import { expect, it } from "vitest";

it("keeps styles/generated/themes.css in sync with @gram/themes", async () => {
  await expect(generateStylesheet()).toMatchFileSnapshot("../styles/generated/themes.css");
});
