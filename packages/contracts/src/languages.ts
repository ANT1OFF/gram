// Syntax-highlighting languages by file name, shared by the Files panel and transcript diffs.

const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
};

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  sql: "sql",
  graphql: "graphql",
  proto: "proto",
  tf: "hcl",
  lua: "lua",
};

/** A syntax-highlighting language id from the file name or extension; `undefined` when unknown. */
export const languageFor = (path: string): string | undefined => {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  const dot = name.lastIndexOf(".");
  return (
    LANGUAGE_BY_NAME[name] ?? (dot > 0 ? LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] : undefined)
  );
};
