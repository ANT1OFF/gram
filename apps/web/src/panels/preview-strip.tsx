// The Preview tab's address strip parts, shared by the shell's pane and the server's page.

import { Bot, Circle, HandGrab } from "lucide-react";
import type { ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatLogTime } from "@/lib/time";

/**
 * What the agent's latest input on the page is for, as it said ("Opens the Filters menu"), and
 * whether it is recording the page, so the user can follow along. While the user drives, frames
 * aren't taken, but the recording is still shown.
 */
export function AgentActivity({
  driver,
  action,
  recording,
}: {
  driver: "agent" | "user" | undefined;
  action: { readonly summary: string; readonly at: number } | undefined;
  recording: boolean;
}) {
  // A recording is shown whoever drives; the agent's latest label only while it does.
  const label = driver === "agent" ? action : undefined;
  if (label === undefined && !recording) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="preview-activity"
      className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1 text-meta text-muted-foreground"
    >
      {recording && (
        <span
          data-testid="preview-recording"
          className="flex shrink-0 items-center gap-1 text-destructive"
        >
          <Circle aria-hidden className="size-2.5 fill-current" />
          Recording
        </span>
      )}
      {label !== undefined && (
        <>
          <Bot aria-hidden className="size-icon-row shrink-0 text-status-working" />
          <span data-testid="preview-action" className="min-w-0 truncate" title={label.summary}>
            {label.summary}
          </span>
          <time
            className="ml-auto shrink-0 tabular-nums"
            dateTime={new Date(label.at).toISOString()}
          >
            {formatLogTime(label.at)}
          </time>
        </>
      )}
    </div>
  );
}

/**
 * Who drives the page, once the thread's agent has used it: the agent, until the user clicks or
 * types in the page, and then the user, until they hand it back here.
 */
export function DriverButton({
  driver,
  onHandBack,
  onTakeOver,
}: {
  driver: "agent" | "user" | undefined;
  onHandBack: (() => void) | undefined;
  onTakeOver: (() => void) | undefined;
}) {
  if (driver === undefined) return null;
  if (driver === "agent") {
    return (
      <span data-testid="preview-driver" data-driver="agent" className="contents">
        {onTakeOver === undefined ? (
          <Hint
            label="The agent is driving this page. Click or type in it to take over."
            render={
              <span
                role="img"
                aria-label="The agent is driving"
                tabIndex={0}
                className="flex size-6 items-center justify-center text-status-working"
              />
            }
          >
            <Bot aria-hidden className="size-icon-row" />
          </Hint>
        ) : (
          <ToolButton
            label="Take control of this page; pause agent input"
            disabled={false}
            onClick={onTakeOver}
          >
            <Bot />
          </ToolButton>
        )}
      </span>
    );
  }
  return (
    <span data-testid="preview-driver" data-driver="user" className="contents">
      <ToolButton
        label="You have control. Hand the page back to the agent"
        disabled={onHandBack === undefined}
        onClick={() => onHandBack?.()}
      >
        <HandGrab />
      </ToolButton>
    </span>
  );
}

/** An icon button in the address strip, its hint above it: below, the page would cover it. */
export function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint
      label={label}
      render={
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          className="shrink-0 text-muted-foreground"
          onClick={onClick}
        />
      }
    >
      {children}
    </Hint>
  );
}
