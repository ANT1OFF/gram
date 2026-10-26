import type { ThreadId } from "@gram/contracts";
import { createContext, use, type ComponentProps } from "react";

import { MessageResponse, type MessageResponseProps } from "@/components/ai-elements/message";
import { OutboundLink } from "@/panels/outbound-link";

import { CheckoutImage } from "./image-preview";
import { resolveInCheckout } from "./relative-path";

const LINK = "text-link underline underline-offset-2";

/**
 * Raw HTML stays sanitized; harden is dropped because it rewrites `../x` to `/x` and blocks relative
 * images before the components below can resolve them. Those components are the URL policy here.
 */
const REHYPE_PLUGINS: MessageResponseProps["rehypePlugins"] = (defaults) => [
  defaults.raw!,
  defaults.sanitize!,
];

interface MarkdownFile {
  threadId: ThreadId;
  root: string;
  path: string;
  /** Outside the thread's checkouts, where only paths the thread's messages name can be read. */
  elsewhere?: boolean | undefined;
  onOpen: (target: string) => void;
}

const MarkdownFileContext = createContext<MarkdownFile | undefined>(undefined);

function MarkdownLink({ href, children }: ComponentProps<"a">) {
  const file = use(MarkdownFileContext)!;
  const target =
    href === undefined || file.elsewhere
      ? undefined
      : resolveInCheckout(href, file.path, file.root);
  if (target !== undefined) {
    return (
      <a
        href={href}
        data-checkout-link={target}
        className={LINK}
        onClick={(event) => {
          event.preventDefault();
          file.onOpen(target);
        }}
      >
        {children}
      </a>
    );
  }
  if (href !== undefined && /^(https?:|mailto:)/i.test(href)) {
    return (
      <OutboundLink href={href} className={LINK} untrusted>
        {children}
      </OutboundLink>
    );
  }
  return <span>{children}</span>;
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const file = use(MarkdownFileContext)!;
  const target =
    typeof src === "string" && !file.elsewhere
      ? resolveInCheckout(src, file.path, file.root)
      : undefined;
  if (target !== undefined) {
    return <CheckoutImage threadId={file.threadId} path={target} alt={alt ?? ""} />;
  }
  return (
    <span className="text-muted-foreground" title={typeof src === "string" ? src : undefined}>
      [{alt || "image"}]
    </span>
  );
}

const COMPONENTS = { a: MarkdownLink, img: MarkdownImage };

/**
 * A markdown file rendered like a message. Relative links open the target in the Files panel and
 * relative images load from the checkout; external links go to the browser. Remote images are
 * never fetched, so a README can't phone home.
 */
export function MarkdownPreview({ content, ...file }: MarkdownFile & { content: string }) {
  return (
    <MarkdownFileContext value={file}>
      {/* A readable measure, centred once the panel is wide, at the transcript's body size. */}
      <div
        data-testid="markdown-preview"
        className="mx-auto w-full max-w-3xl px-6 py-5 text-sm leading-relaxed"
      >
        <MessageResponse components={COMPONENTS} rehypePlugins={REHYPE_PLUGINS}>
          {content}
        </MessageResponse>
      </div>
    </MarkdownFileContext>
  );
}
