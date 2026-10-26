import { ALWAYS_ASKS_BECAUSE, isTrustedLink, linkHost } from "@gram/contracts";
import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import type { LinkSafetyConfig, LinkSafetyModalProps } from "streamdown";

import { Button } from "@/components/ui/button";
import { copyText } from "@/settings/copy-text";
import { DialogShell } from "@/thread/dialog-shell";

import { shellAsksAboutLinks, usePageTrustedLinks } from "./trusted-links";

/**
 * "Open external link?" for a link in a message, in a browser. It leads with the host the link
 * really goes to, so a look-alike stands out, and offers to trust that exact host from then on.
 */
function LinkDialog({ isOpen, ...props }: LinkSafetyModalProps) {
  // Mounted only while open, so the checkbox starts clear every time.
  return isOpen ? <OpenLinkDialog {...props} /> : null;
}

function OpenLinkDialog({ onClose, onConfirm, url }: Omit<LinkSafetyModalProps, "isOpen">) {
  const [trust, setTrust] = useState(false);
  const add = usePageTrustedLinks((s) => s.add);
  const link = linkHost(url);
  return (
    <DialogShell testId="link-dialog" title="Open external link?" onClose={onClose}>
      {link === null ? (
        <p className="text-sm text-muted-foreground">Only http and https links open.</p>
      ) : (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <span className="text-xs text-muted-foreground">This link goes to</span>
          <span
            data-testid="link-dialog-host"
            className="font-mono text-base font-semibold break-all text-foreground"
          >
            {link.host}
          </span>
          {link.written !== undefined && (
            <span className="text-xs text-muted-foreground">
              The link spells it <span className="font-mono">{link.written}</span>.
            </span>
          )}
        </div>
      )}
      <p className="max-h-28 overflow-auto font-mono text-xs break-all text-muted-foreground">
        {url}
      </p>
      {link !== null &&
        (link.untrustable === undefined ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={trust}
              onChange={(event) => setTrust(event.target.checked)}
            />
            <span>
              Always open links to <span className="font-mono">{link.host}</span> without asking
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">{ALWAYS_ASKS_BECAUSE[link.untrustable]}</p>
        ))}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            copyText(url).catch((error: unknown) => console.error("link copy", error));
            onClose();
          }}
        >
          <Copy data-icon="inline-start" />
          Copy link
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={link === null}
          onClick={() => {
            if (trust && link !== null && link.untrustable === undefined) add(link.host);
            onConfirm();
            onClose();
          }}
        >
          <ExternalLink data-icon="inline-start" />
          Open link
        </Button>
      </div>
    </DialogShell>
  );
}

interface PendingQuestion {
  readonly url: string;
  readonly answer: (open: boolean) => void;
}

const useLinkQuestion = create<{ pending: PendingQuestion | undefined }>(() => ({
  pending: undefined,
}));

/**
 * Whether the page may open `url` from content it didn't write, such as a terminal or a previewed
 * file: at once for a trusted host, otherwise once `LinkQuestion` has asked. Only for a browser;
 * the desktop shell asks for itself.
 */
export function askToOpen(url: string): Promise<boolean> {
  if (isTrustedLink(url, usePageTrustedLinks.getState().hosts)) return Promise.resolve(true);
  // A new question replaces one still unanswered, which then opens nothing.
  useLinkQuestion.getState().pending?.answer(false);
  return new Promise((resolve) => {
    let answered = false;
    const answer = (open: boolean) => {
      if (answered) return;
      answered = true;
      if (useLinkQuestion.getState().pending?.answer === answer) {
        useLinkQuestion.setState({ pending: undefined });
      }
      resolve(open);
    };
    useLinkQuestion.setState({ pending: { url, answer } });
  });
}

/** Where `askToOpen` asks: mounted once, at the app's root. */
export function LinkQuestion() {
  const pending = useLinkQuestion((s) => s.pending);
  if (pending === undefined) return null;
  return (
    <LinkDialog
      key={pending.url}
      isOpen
      url={pending.url}
      onConfirm={() => pending.answer(true)}
      onClose={() => pending.answer(false)}
    />
  );
}

const PAGE_ASKS: LinkSafetyConfig = {
  enabled: true,
  onLinkCheck: (url) => isTrustedLink(url, usePageTrustedLinks.getState().hosts),
  renderModal: (props) => <LinkDialog {...props} />,
};

/**
 * How a message's links are guarded: in the desktop app the shell asks before anything opens, so
 * the page hands every link straight to it; in a browser the page asks itself.
 */
export const messageLinkSafety = (): LinkSafetyConfig =>
  shellAsksAboutLinks() ? { enabled: false } : PAGE_ASKS;
