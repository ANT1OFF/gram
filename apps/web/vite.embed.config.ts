import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, esmExternalRequirePlugin } from "vite";

/**
 * The web app as a module another app mounts (`src/embed/index.ts`), in `dist-embed`: one entry,
 * `gram-web.js`, one stylesheet, `gram-web.css`, and beside them the chunks and assets they load.
 * React is left for the embedding app to bring, so its own pages render in the same tree as Gram's.
 * See docs/EMBEDDING.md.
 */
const REACT = [/^react($|\/)/, /^react-dom($|\/)/];

export default defineConfig({
  plugins: [
    // Must run before the React plugin so generated route files are transformed too. The route
    // tree is the checked-in one: this build never writes it.
    tanstackRouter({ target: "react", autoCodeSplitting: true, enableRouteGeneration: false }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // React stays outside the bundle, also for the dependencies that `require` it: a `require`
    // left in an ES module has nothing to call in a browser.
    esmExternalRequirePlugin({ external: REACT }),
  ],
  // Every chunk and asset is found from the file that names it, wherever the package is served.
  base: "./",
  // The app's own page shell (favicon, asset guard) is the embedding app's to bring.
  publicDir: false,
  build: {
    outDir: "dist-embed",
    emptyOutDir: true,
    // One stylesheet the embedding app links, rather than one per lazily loaded part.
    cssCodeSplit: false,
    // The embedding app's bundler decides what to preload; paths baked in here would be stale.
    modulePreload: false,
    chunkSizeWarningLimit: 2050,
    rolldownOptions: {
      input: { "gram-web": fileURLToPath(new URL("./src/embed/index.ts", import.meta.url)) },
      // The entry's exports are the package's: keep them as written.
      preserveEntrySignatures: "strict",
      checks: { pluginTimings: false },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css"))
            ? "gram-web.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
