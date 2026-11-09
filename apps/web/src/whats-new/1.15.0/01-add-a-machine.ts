import type { WhatsNewItem } from "../index";

export default {
  title: "Add a machine in one step",
  body: "Add a machine in Settings → Machines now joins another Mac or Linux machine without a Gram checkout. Copy the one command it shows and run it there: it uses the Gram app already installed on that machine, or downloads this Gram's own release and checks it first. Or choose Add over SSH, type the machine's SSH address or pick a host from your SSH config, and Gram installs and joins it from here, confirming it by the key fingerprint the install prints. If access over Tailscale is off, the dialog can now turn it on, or lists what Tailscale still needs.",
} satisfies WhatsNewItem;
