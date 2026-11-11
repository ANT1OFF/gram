import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dist = (file: string) => fileURLToPath(new URL(`../../dist-embed/${file}`, import.meta.url));

/**
 * An app of its own that consumes the built package the way an app in front of Gram does: by its
 * entry and its stylesheet, with its own React. Nothing of Gram's sources or build is in here.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Its own Tailwind build, for its own pages, on the names of Gram's theme.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "gram-web/style.css", replacement: dist("gram-web.css") },
      { find: "gram-web/theme.css", replacement: dist("theme.css") },
      { find: "gram-web/kit", replacement: dist("gram-web-kit.js") },
      { find: "gram-web", replacement: dist("gram-web.js") },
    ],
    // One React for the page: Gram's package leaves it to the app.
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist-embed-fixture", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2050,
    rolldownOptions: { checks: { pluginTimings: false } },
  },
});
