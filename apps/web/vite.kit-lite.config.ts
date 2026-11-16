import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, esmExternalRequirePlugin } from "vite";

/**
 * The light kit (`src/embed/kit-lite.ts`) and its own stylesheet (`src/embed/kit-lite.css`), into
 * `dist-embed` beside the package's other entries: Gram's basic controls for a page that shows
 * before Gram mounts, built on their own so such a page loads none of the app. The same sources
 * as the full kit; `scripts/build-embed.mjs` runs it after the main build and checks its budget.
 * See docs/EMBEDDED_WEB_APP.md.
 */
const REACT = [/^react($|\/)/, /^react-dom($|\/)/];

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    esmExternalRequirePlugin({ external: REACT }),
  ],
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist-embed",
    // The main build has written the rest of the package already.
    emptyOutDir: false,
    // On, so the stylesheet can be an entry of its own; the light kit's code imports no CSS.
    cssCodeSplit: true,
    modulePreload: false,
    rolldownOptions: {
      input: {
        "gram-web-kit-lite": fileURLToPath(new URL("./src/embed/kit-lite.ts", import.meta.url)),
        "gram-web-kit-lite-style": fileURLToPath(
          new URL("./src/embed/kit-lite.css", import.meta.url),
        ),
      },
      preserveEntrySignatures: "strict",
      checks: { pluginTimings: false },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/lite-[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css"))
            ? "gram-web-kit-lite.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
