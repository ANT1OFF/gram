/** What swaps the real agents for the echo fake (`packages/server/src/main.ts`). */
const FAKE_AGENT_KEYS = ["GRAM_FAKE_AGENT", "GRAM_FAKE_AGENT_REPLY"] as const;

/** What moves the server off loopback, for the container image only (`server/src/config.ts`). */
const CONTAINER_KEYS = ["GRAM_CONTAINER", "GRAM_LISTEN_HOST"] as const;

/**
 * The shell's environment as the server inherits it. The desktop's server always listens on
 * loopback, so the container's listen variables are dropped. In a packaged build a variable must
 * not be able to replace the user's agents, so the fake's are dropped too. A `--smoke` run keeps
 * them: the release's packaged check boots on the fake, takes no turn and exits on its own.
 */
export function inheritedServerEnv(
  env: NodeJS.ProcessEnv,
  { packaged, smoke }: { readonly packaged: boolean; readonly smoke: boolean },
): NodeJS.ProcessEnv {
  const inherited = { ...env };
  for (const key of CONTAINER_KEYS) delete inherited[key];
  if (!packaged || smoke) return inherited;
  for (const key of FAKE_AGENT_KEYS) delete inherited[key];
  return inherited;
}
