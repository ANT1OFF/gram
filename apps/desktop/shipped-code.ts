// How every Node-side bundle the app ships is built: main, preload, the server, its command worker
// and speech. They are minified with every comment but license ones stripped,
// and no source maps, so the package doesn't carry the private source in readable form. Function
// and class names stay, for the stack traces in the logs.
//
// The dev loop sets `GRAM_READABLE_BUNDLES=1` for readable bundles; verify-package.mjs fails a
// package built that way.

const readable = process.env["GRAM_READABLE_BUNDLES"] === "1";

/** Vite `build` options. */
export const shippedBuild = { minify: !readable, sourcemap: false } as const;

/** Rolldown `output` options. */
export const shippedOutput = {
  keepNames: true,
  comments: readable ? true : { legal: true, annotation: false, jsdoc: false },
} as const;
