import type { ToolAudience } from "@gram/agents";
import { AppToolError } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { PLAYBOOKS, playbookText, type Playbook } from "./playbooks.ts";

const TOOL = "read_playbook";

const variantPerSetOfOfferedPlaybooks = (): ReadonlyArray<{
  readonly audience: ReadonlyArray<ToolAudience>;
  readonly playbooks: ReadonlyArray<Playbook>;
}> => {
  const byKey = new Map<string, { audience: Array<ToolAudience>; playbooks: Array<Playbook> }>();
  for (const audience of ["plain", "worker", "orchestrator"] as const) {
    const playbooks = PLAYBOOKS.filter((playbook) => playbook.audience.includes(audience));
    if (playbooks.length === 0) continue;
    const key = playbooks.map((playbook) => playbook.name).join(" ");
    const variant = byKey.get(key);
    if (variant === undefined) byKey.set(key, { audience: [audience], playbooks });
    else variant.audience.push(audience);
  }
  return [...byKey.values()];
};

const readPlaybook = (
  audience: ReadonlyArray<ToolAudience>,
  playbooks: ReadonlyArray<Playbook>,
) => {
  const [first, ...rest] = playbooks.map((playbook) => playbook.name);
  return defineAppTool({
    descriptor: {
      name: TOOL,
      class: "read",
      description: "Read a Gram playbook: the recipes its tools' descriptions leave out.",
    },
    audience,
    input: Schema.Struct({ name: Schema.Literals([first ?? "", ...rest]) }),
    handle: (_caller, { name }) =>
      Effect.gen(function* () {
        const playbook = playbooks.find((candidate) => candidate.name === name);
        if (playbook === undefined)
          return yield* new AppToolError({ tool: TOOL, message: `No playbook "${name}".` });
        return yield* Effect.tryPromise({
          try: () => playbookText(playbook),
          catch: () =>
            new AppToolError({
              tool: TOOL,
              message: `The playbook "${name}" isn't in this build of Gram.`,
            }),
        });
      }),
  });
};

export const PlaybookAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    yield* registry.register(
      variantPerSetOfOfferedPlaybooks().map(({ audience, playbooks }) =>
        readPlaybook(audience, playbooks),
      ),
    );
  }),
);
