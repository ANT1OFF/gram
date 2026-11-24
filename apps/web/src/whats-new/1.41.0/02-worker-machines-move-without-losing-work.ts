import type { WhatsNewItem } from "../index";

export default {
  title: "Worker machines move without losing work",
  body: "When the provider of a hosted worker machine asks to move it, Gram saves its threads' work, readies the machine and lets it move. Its threads show the machine as moving and carry on by themselves once it is back.",
} satisfies WhatsNewItem;
