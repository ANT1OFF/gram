import { Tools, type ToolStatus } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Fixed readiness for offline tests; never probes PATH, account files or `gh auth status`. */
export const testTools = (state: {
  readonly git: boolean;
  readonly gh: "ready" | "signed-out" | "missing";
  readonly claude: boolean;
}): Layer.Layer<Tools> => {
  const status: ToolStatus = {
    git: state.git,
    gh: state.gh !== "missing",
    ghAuthed: state.gh === "ready",
    claude: state.claude,
  };
  return Layer.succeed(Tools, {
    present: (bin) =>
      Effect.succeed(
        bin === "git" ? status.git : bin === "gh" ? status.gh : bin === "claude" && status.claude,
      ),
    ghReady: Effect.succeed(status.ghAuthed),
    check: Effect.succeed(status),
  });
};
