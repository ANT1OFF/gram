// What a thread's profile adds to every session it opens: its charter, its outward gate and its
// MCP servers. Laid over whatever the thread's role gives, so it holds whoever else has a say.
import type { OutwardGate } from "@gram/agents";
import { profileAutonomyOf, type ProfileAutonomy, type Thread } from "@gram/contracts";
import type { SessionPolicy } from "../runtime/session-policy.ts";

/** The outward gate a profile's level opens a session with, as a workspace's autonomy does. */
const gateOf = (autonomy: ProfileAutonomy): OutwardGate | undefined =>
  autonomy === "supervised" ? "all" : autonomy === "publish" ? "irreversible" : undefined;

/** The stricter of two gates: `all` over `irreversible` over none. */
const stricter = (a: OutwardGate | undefined, b: OutwardGate | undefined) =>
  a === "all" || b === "all" ? "all" : (a ?? b);

/**
 * `policy` for a thread started from a profile; the same policy for any other thread.
 *
 * - The charter follows the instructions the policy already has, so it reads as the more specific.
 * - The gate is the profile's level, or the policy's own where that is stricter.
 * - The session is held to the profile's one MCP server, by its address, or to none: the lists a
 *   role gave are replaced, since a profile's set is the whole of what its thread may reach.
 */
export const withProfile = (
  policy: SessionPolicy,
  thread: Pick<Thread, "profile">,
): SessionPolicy => {
  const profile = thread.profile;
  if (profile === undefined) return policy;
  const charter = profile.charter.trim();
  const instructions = [policy.instructions, charter === "" ? undefined : charter]
    .filter((part) => part !== undefined)
    .join("\n\n");
  const { mcpDenylist: _, mcpNoneWithoutToolSearch: __, mcpServer: ___, ...rest } = policy;
  return {
    ...rest,
    ...(instructions === "" ? {} : { instructions }),
    outwardGate: stricter(policy.outwardGate, gateOf(profileAutonomyOf(profile))),
    mcpAllowlist: profile.server === undefined ? [] : [profile.server.url],
    ...(profile.server === undefined ? {} : { mcpServer: profile.server }),
  };
};
