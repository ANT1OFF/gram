import type { AgentKind, TaskWorkerChoice } from "@gram/contracts";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { GHOST_TRIGGER } from "./styles";
import {
  firstWorkerChoiceOf,
  workerAgents,
  workerChoiceKey,
  workerChoiceLabel,
} from "./worker-choice";

/**
 * A direct worker's agent and model, from the roster the task preview offers: the agent narrows the
 * models to its own, each with what the user said it is for, and one that can't run here is shown
 * but can't be picked, with why.
 */
export function WorkerFields({
  choices,
  shown,
  onPick,
  disabled = false,
}: {
  choices: readonly TaskWorkerChoice[];
  shown: TaskWorkerChoice;
  onPick: (key: string) => void;
  disabled?: boolean;
}) {
  const agents = workerAgents(choices);
  const agent = shown.model.agent;
  const models = choices.filter((choice) => choice.model.agent === agent);
  const agentItems = agents.map((each) => ({ value: each, label: agentLabel(each) }));
  const modelItems = models.map((choice) => ({
    value: workerChoiceKey(choice.model),
    label: workerChoiceLabel(choice.model),
  }));

  return (
    <>
      {agents.length > 1 ? (
        <Select
          value={agent}
          items={agentItems}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === null || next === agent) return;
            const first = firstWorkerChoiceOf(choices, next as AgentKind);
            if (first !== undefined) onPick(workerChoiceKey(first.model));
          }}
        >
          <SelectTrigger size="sm" aria-label="Worker agent" className={GHOST_TRIGGER}>
            <AgentIcon agent={agent} className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top">
            {agentItems.map((item) => {
              const usable = firstWorkerChoiceOf(choices, item.value) !== undefined;
              return (
                <SelectItem key={item.value} value={item.value} disabled={!usable}>
                  <AgentIcon agent={item.value} className="size-3.5 text-muted-foreground" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{item.label}</span>
                    {!usable && (
                      <span className="text-xs whitespace-normal text-muted-foreground">
                        No roster model of it can run here
                      </span>
                    )}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : (
        <span className="flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground">
          <AgentIcon agent={agent} className="size-3.5" />
          {agentLabel(agent)}
        </span>
      )}
      <Select
        value={workerChoiceKey(shown.model)}
        items={modelItems}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null) onPick(next);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Worker model"
          data-warning={shown.unavailable === undefined ? undefined : "true"}
          className={GHOST_TRIGGER}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent side="top">
          {models.map((choice) => {
            const why = choice.unavailable ?? choice.useFor;
            return (
              <SelectItem
                key={workerChoiceKey(choice.model)}
                value={workerChoiceKey(choice.model)}
                disabled={choice.unavailable !== undefined}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {workerChoiceLabel(choice.model)}
                    {choice.default === true && (
                      <span className="ml-1.5 text-xs text-muted-foreground">Default</span>
                    )}
                  </span>
                  {why !== undefined && (
                    <span className="max-w-80 text-xs whitespace-normal text-muted-foreground">
                      {choice.unavailable === undefined ? why : `Unavailable: ${why}`}
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </>
  );
}
