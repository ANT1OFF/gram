import { acquireSlot, slotCount, slotDir } from "../check/slots.mjs";

/**
 * Release checks use synthetic HOME/XDG stores and CI=1 for account isolation. Claim the
 * developer's normal machine slot here, before entering that environment, even on CI.
 * Stable draft preparation and RCs share this path; later stable phases do not run tests.
 */
export async function withReleaseCheckSlot(check, { source, say, env = process.env } = {}) {
  const slots = slotCount(env);
  const free = await acquireSlot({
    dir: slotDir(env),
    slots,
    label: source,
    onWait: (holders) =>
      say(
        `Waiting for one of ${slots} check slots on this machine, held by:\n` +
          holders.map((h) => `    ${h.cwd} (pid ${h.pid}, since ${h.since})`).join("\n"),
      ),
  });
  try {
    return await check();
  } finally {
    free();
  }
}
