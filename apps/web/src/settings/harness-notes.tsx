import type { AgentKind } from "@gram/contracts";
import { Popover } from "@base-ui/react/popover";
import { CircleHelp } from "lucide-react";

import { agentLabel } from "@/agents/agent-display";

import { LONG_COPY } from "./fields";
import { DREAM_HARNESS_NOTE } from "./workspace-settings-model";

/**
 * "How Codex differs": what to know before letting a harness take a role, and how a Dream is held
 * on each, behind a ? on the worker models' line while such a harness is in use.
 */
export function HarnessNotes({
  notes,
}: {
  notes: readonly {
    readonly agent: AgentKind;
    readonly notes: readonly string[];
  }[];
}) {
  if (notes.length === 0) return null;
  const label = `How ${notes.map((each) => agentLabel(each.agent)).join(" and ")} differs`;
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="harness-notes"
        className="flex items-center gap-1 rounded-sm text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CircleHelp aria-hidden className="size-icon-row" />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Popover.Popup
            data-surface="overlay"
            aria-label={label}
            {...{ [LONG_COPY]: "learn more" }}
            className="flex max-h-(--available-height) max-w-md origin-(--transform-origin) flex-col gap-2 overflow-y-auto rounded-md border border-edge bg-popover px-3 py-2 text-meta text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            {notes.map(({ agent, notes: lines }) => (
              <section key={agent} data-testid={`harness-note-${agent}`}>
                <h4 className="font-medium">{agentLabel(agent)}</h4>
                <ul className="flex list-disc flex-col gap-0.5 pt-1 pl-4 text-muted-foreground">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            ))}
            <section data-testid="harness-note-dreams">
              <h4 className="font-medium">Memory updates</h4>
              <p className="pt-1 text-muted-foreground">{DREAM_HARNESS_NOTE}</p>
            </section>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
