/** What swaps the real agents for the echo fake (`packages/server/src/main.ts`). */
const FAKE_AGENT_KEYS = ["GRAM_FAKE_AGENT", "GRAM_FAKE_AGENT_REPLY"] as const;

/**
 * The shell's environment as the server inherits it. In a packaged build a variable must not be
 * able to replace the user's agents, so the fake's are dropped. A `--smoke` run keeps them: the
 * release's packaged check boots on the fake, takes no turn and exits on its own.
 */
export function inheritedServerEnv(
  env: NodeJS.ProcessEnv,
  { packaged, smoke }: { readonly packaged: boolean; readonly smoke: boolean },
): NodeJS.ProcessEnv {
  if (!packaged || smoke) return { ...env };
  const inherited = { ...env };
  for (const key of FAKE_AGENT_KEYS) delete inherited[key];
  return inherited;
}
