import type { WhatsNewItem } from "../index";

export default {
  title: "Smoother under load",
  body: "Gram's database now works beside the app instead of on its main loop, so large writes no longer stall the window. Open checkouts that Gram is already watching are re-read far less often, and on macOS an idle checkout is checked a small fraction as often as before.",
} satisfies WhatsNewItem;
