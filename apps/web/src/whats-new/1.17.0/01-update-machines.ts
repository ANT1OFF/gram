import type { WhatsNewItem } from "../index";

export default {
  title: "Update joined machines from this Gram",
  body: "Settings → Machines now has an Update icon on each joined machine that runs an older release than this Gram, and Update all when several do. The machine fetches and checks the release over its own connection, switches once nothing runs there and goes back to the one it had if the new release doesn't come back healthy, and Update machines automatically, on by default, does this whenever a machine is idle. A machine's first update to 1.17.0 still runs the install command again.",
} satisfies WhatsNewItem;
