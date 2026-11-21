import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paletteDataJson } from "../src/palette-data.ts";

const target = fileURLToPath(new URL("../palette.json", import.meta.url));
writeFileSync(target, paletteDataJson());
console.log(`Wrote ${target}.`);
