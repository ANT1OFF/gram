import { CircleAlert, CircleCheck, CloudUpload, Laptop, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";

import { type SendCheckRow, type SendTarget, sendTargetKey, sentModelLabel } from "./send-target";

/** The picker's value for this computer. */
const HERE = "__here__";

/**
 * New task's Machine stop, once a server signed in to runs work sent to it: this computer, or one
 * of the hosted workspaces under its server. Picking one sends the task there instead.
 */
export function SendTargetPicker({
  targets,
  value,
  onChange,
  here,
  disabled,
}: {
  targets: readonly SendTarget[];
  value: SendTarget | undefined;
  onChange: (next: SendTarget | undefined) => void;
  /** "This Mac" or "This computer". */
  here: string;
  disabled?: boolean;
}) {
  const hosts = [...new Set(targets.map((target) => target.host))];
  const items = [
    { value: HERE, label: here },
    ...targets.map((target) => ({
      value: sendTargetKey(target),
      label: `${target.workspace} · ${target.host}`,
    })),
  ];
  return (
    <Select
      value={value === undefined ? HERE : sendTargetKey(value)}
      items={items}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === null) return;
        onChange(targets.find((target) => sendTargetKey(target) === next));
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={
          value === undefined ? `Machine: ${here}` : `Machine: ${value.workspace} on ${value.host}`
        }
        className="h-7 max-w-64 text-meta"
        data-testid="send-target"
      >
        {value === undefined ? (
          <Laptop aria-hidden className="size-icon-row text-muted-foreground" />
        ) : (
          <CloudUpload aria-hidden className="size-icon-row text-muted-foreground" />
        )}
        <span className="truncate">
          {value === undefined ? here : `${value.workspace} · ${value.host}`}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={HERE}>{here}</SelectItem>
        {hosts.map((host) => (
          <div key={host} role="presentation">
            <SelectSeparator />
            <div role="presentation" className="px-1.5 py-1 text-meta text-muted-foreground">
              Hosted workspaces · {host}
            </div>
            {targets
              .filter((target) => target.host === host)
              .map((target) => (
                <SelectItem
                  key={sendTargetKey(target)}
                  value={sendTargetKey(target)}
                  description={`${target.organisation} · runs there, under its rules`}
                >
                  {target.workspace}
                </SelectItem>
              ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

const glyphs = {
  ok: { Icon: CircleCheck, tone: "text-success" },
  warn: { Icon: TriangleAlert, tone: "text-warning" },
  block: { Icon: CircleAlert, tone: "text-destructive" },
} as const;

/**
 * Where a sent task runs, and the checks before it goes: what blocks Send and what only warns.
 * While the checks are asked, says so; when they couldn't be, says why with Check again.
 */
export function SendChecks({
  target,
  here,
  rows,
  model,
  error,
  checking,
  onRecheck,
}: {
  target: SendTarget;
  /** "this Mac" or "this computer". */
  here: string;
  rows: readonly SendCheckRow[] | undefined;
  /** What a thread there opens on now, when the server said. */
  model?: { readonly agent: string; readonly model: string } | undefined;
  error: string | undefined;
  checking: boolean;
  onRecheck: () => void;
}) {
  return (
    <div data-testid="send-checks" className="flex flex-col gap-3">
      <p className="text-reading text-muted-foreground">
        Runs in <span className="text-foreground">{target.workspace}</span> on{" "}
        <span className="text-foreground">{target.host}</span>, as a thread of that workspace. It
        keeps going when {here} sleeps, and reports to this workspace's orchestrator.{" "}
        {target.organisation}'s rules and approvals apply there, not this workspace's autonomy.
        {model !== undefined && (
          <>
            {" "}
            It runs on <span className="text-foreground">{sentModelLabel(model)}</span>, the model
            that workspace starts threads on.
          </>
        )}
      </p>
      {rows === undefined ? (
        error === undefined ? (
          <p role="status" className="flex items-center gap-2 text-meta text-muted-foreground">
            <Spinner aria-hidden className="size-3" /> Checking with {target.server}…
          </p>
        ) : (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-meta text-destructive">
            <CircleAlert aria-hidden className="size-icon-chip shrink-0" />
            {error}
            <Button type="button" size="xs" variant="outline" onClick={onRecheck}>
              Check again
            </Button>
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-2" aria-busy={checking}>
          {rows.map((row) => {
            const { Icon, tone } = glyphs[row.state];
            return (
              <li
                key={row.id}
                data-testid={`send-check-${row.id}`}
                data-state={row.state}
                className="flex items-start gap-2"
              >
                <Icon aria-hidden className={cn("mt-0.5 size-icon-row shrink-0", tone)} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-reading">{row.title}</span>
                  {row.detail !== undefined && (
                    <span className="text-meta text-muted-foreground">{row.detail}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
