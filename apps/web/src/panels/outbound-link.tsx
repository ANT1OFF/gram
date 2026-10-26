import type { ReactNode } from "react";

import { askToOpen } from "@/links/link-dialog";
import { cn } from "@/lib/utils";

/** Opens `href` in the default browser: through the desktop bridge when present, else a new tab. */
export function OutboundLink({
  href,
  className,
  title,
  untrusted = false,
  children,
}: {
  href: string;
  className?: string;
  /** The anchor's tooltip; the guarded button shows the href instead. */
  title?: string;
  /**
   * For a link the app didn't write, such as one in a previewed file: in a browser it asks before
   * the tab opens. The desktop shell asks about every link either way.
   */
  untrusted?: boolean;
  children: ReactNode;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.gram;
  if (untrusted && !bridge?.openExternal) {
    // A button, as Streamdown draws the links it guards: an anchor's middle-click and context menu
    // would open the href without asking. A `mailto:` gets the question too, which opens only
    // http(s).
    return (
      <button
        type="button"
        title={href}
        className={cn("cursor-pointer text-left", className)}
        onClick={() => {
          void askToOpen(href).then((allowed) => {
            if (allowed) window.open(href, "_blank", "noreferrer");
          });
        }}
      >
        {children}
      </button>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={className}
      onClick={(event) => {
        if (!bridge?.openExternal) return;
        event.preventDefault();
        void bridge.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
