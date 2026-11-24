import type { WhatsNewItem } from "../index";

export default {
  title: "A thread waits while its machine is replaced",
  body: "When the machine a thread runs on is replaced, the thread says the machine is moving and resumes on its own once it is back, instead of failing the turn. If the machine doesn't come back in time, the thread stops and says why.",
} satisfies WhatsNewItem;
