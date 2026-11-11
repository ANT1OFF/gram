// The entry an app in front of Gram loads (`bun run --filter @gram/web build:embed`): the whole web
// app behind one call, and the few things its own pages need from the shell. See docs/EMBEDDING.md.
import "../styles/globals.css";

export type * from "./contract";
export { mountGram, ShellLink, useShellLocation } from "./mount";
