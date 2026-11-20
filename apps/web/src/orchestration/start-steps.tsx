// What New workspace's Start will do (new-workspace.tsx), in order.

/**
 * What Start will do, in order, so nothing it starts is a surprise: the machine where one is
 * needed, the survey where it is on, then the first task, or a wait for one with nothing run.
 */
export function StartSteps({
  machine,
  environment,
  reads,
  task,
}: {
  /** The machine's word where Start must start one first. */
  machine: string | undefined;
  /** The environment it starts in, where the embedding app offers a choice. */
  environment: string | undefined;
  reads: boolean;
  task: boolean;
}) {
  const steps = [
    ...(machine === undefined
      ? []
      : [
          environment === undefined
            ? `Start a ${machine} and check out the repositories`
            : `Start a ${machine} on ${environment} and check out the repositories`,
        ]),
    ...(reads ? ["The orchestrator reads the repositories"] : []),
    task
      ? "The orchestrator plans the first task and starts workers"
      : "Wait for your first task. Nothing else runs until you send one.",
  ];
  return (
    <div data-testid="new-workspace-steps" className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-muted-foreground">Start will</span>
      <ol className="flex flex-col gap-1 text-meta">
        {steps.map((step, index) => (
          <li key={step} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className="w-4 shrink-0 text-right text-muted-foreground tabular-nums"
            >
              {index + 1}.
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
