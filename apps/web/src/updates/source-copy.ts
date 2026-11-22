import type { UpdateSource } from "@gram/contracts";
import { useEffect, useState } from "react";

/** The shell's update source, once it has answered; undefined before then and in older shells. */
export function useUpdateSource(): UpdateSource | undefined {
  const [source, setSource] = useState<UpdateSource>();
  useEffect(() => {
    let live = true;
    void window.gram?.updates
      .source?.()
      .then((answer) => {
        if (live) setSource(answer);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return source;
}

/** The signed updater's note on where its releases come from: always the public feed. */
export function nativeSourceNote(repo: string | null | undefined) {
  return `Releases are read anonymously from ${repo ? `the public ${repo} repository` : "Gram's public release repository"}; no sign-in is needed.`;
}

/** The `gh` updater's copy (Windows): it always reads through the user's `gh`. */
export function ghSourceCopy(source: UpdateSource | undefined) {
  const repo = source?.repo ?? undefined;
  const releases =
    source?.visibility === "public"
      ? `${repo ?? "Gram"} releases`
      : `private ${repo ?? "Gram"} releases`;
  return {
    automaticChecks: `Check for ${releases} with your gh login. Never installs or interrupts agents.`,
  };
}
