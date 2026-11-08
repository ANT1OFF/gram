import { Popover } from "@base-ui/react/popover";
import type { GramUIMessage } from "@gram/contracts";

import { cn } from "@/lib/utils";
import { compactTokens } from "@/usage/usage-model";

import { contextLevel } from "./usage-bar";
import { cachedShare, replyTokens } from "./reply-tokens-model";

const FILL = {
  normal: "bg-muted-foreground",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

/**
 * The tokens the turn this reply ends used, beside its time: "44K tokens", and on hover or a click
 * what makes it up (new input, cache read and write, output and the thinking in it) and how full
 * the context window was after it. Only on a reply stamped with its turn's usage; never dollars,
 * which are the thread's.
 */
export function ReplyTokens({ message }: { message: GramUIMessage }) {
  const tokens = replyTokens(message.metadata?.usage);
  if (tokens === undefined) return null;
  const { context } = tokens;
  const cached = cachedShare(tokens);
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={300}
        data-testid="reply-tokens"
        aria-label={`${tokens.label} this turn`}
        className="rounded-(--radius-sm) px-1.5 py-0.5 text-meta text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {tokens.label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            data-testid="reply-tokens-detail"
            aria-label="Tokens this turn"
            className="w-60 origin-(--transform-origin) rounded-md border border-edge bg-popover p-3 text-meta text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            <p className="font-medium">This turn</p>
            <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
              {tokens.rows.map((row) => (
                <div key={row.key} data-testid={`reply-tokens-${row.key}`} className="contents">
                  <dt className={cn("text-muted-foreground", row.part && "pl-3")}>{row.label}</dt>
                  <dd className="text-right">{row.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-1 flex justify-between gap-3 border-t border-edge pt-1 font-medium tabular-nums">
              <span>Total</span>
              <span data-testid="reply-tokens-total">
                {tokens.partial && "≥ "}
                {compactTokens(tokens.total)}
              </span>
            </p>
            {cached !== undefined && (
              <p data-testid="reply-tokens-cached" className="mt-1 text-muted-foreground">
                {cached}% read from the prompt cache
              </p>
            )}
            {context.percent !== undefined && (
              <div data-testid="reply-tokens-context" className="mt-2.5 grid gap-1">
                <p className="flex justify-between gap-2">
                  <span className="font-medium">Context after</span>
                  <span className="text-muted-foreground tabular-nums">
                    {compactTokens(context.tokens!)} / {compactTokens(context.window!)} ·{" "}
                    {context.percent}%
                  </span>
                </p>
                <span
                  role="meter"
                  aria-label="Context used after this turn"
                  aria-valuenow={context.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="block h-1 overflow-hidden rounded-full bg-foreground/15"
                >
                  <span
                    className={cn("block h-full rounded-full", FILL[contextLevel(context.percent)])}
                    style={{ width: `${context.percent}%` }}
                  />
                </span>
              </div>
            )}
            {tokens.partial && (
              <p className="mt-2 text-muted-foreground">
                At least this many: the agent's count had no clean start.
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
