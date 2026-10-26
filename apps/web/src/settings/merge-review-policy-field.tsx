import {
  MergePolicyRepo,
  mergeReviewPolicyOf,
  reviewBotsOf,
  type MergeReviewPolicy,
  type OrchestratorCharter,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import { Plus, X } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

import { Field, inputCls, OptionGroup } from "./fields";

const OPTIONS = [
  { value: "automatic", label: "Automatic" },
  { value: "solo", label: "Solo development" },
  { value: "bot", label: "Require review bot" },
] as const;

/** Each policy in one line, under the selector while it is picked. */
const POLICY_LINE: Record<MergeReviewPolicy, string> = {
  automatic: "Requires review bot approval when one is set up, otherwise solo.",
  solo: "Merges once CI and GitHub's merge rules pass.",
  bot: "Merges only after a review bot approves the exact head.",
};

const POLICY_LABEL: Record<MergeReviewPolicy, string> = {
  automatic: "Automatic",
  solo: "Solo",
  bot: "Review bot",
};

const SELECT = cn(inputCls, "h-7 w-auto max-w-none text-xs");

type Override = NonNullable<OrchestratorCharter["repoMergeReviewPolicies"]>[number];

/** The charter with these overrides, or none. */
const withOverrides = (
  charter: OrchestratorCharter,
  overrides: readonly Override[],
): OrchestratorCharter => {
  const { repoMergeReviewPolicies: _was, ...rest } = charter;
  return overrides.length === 0 ? rest : { ...rest, repoMergeReviewPolicies: overrides };
};

/** Why `repo` can't be added beside `overrides`, or `undefined`. */
const overrideProblem = (overrides: readonly Override[], repo: string): string | undefined => {
  if (Schema.decodeUnknownOption(MergePolicyRepo)(repo)._tag === "None") {
    return "Use an exact owner/repo, such as octo-org/api.";
  }
  return overrides.some((each) => each.repo.toLowerCase() === repo.toLowerCase())
    ? "That repository already has an override."
    : undefined;
};

/** Workspace-local policy. Exact repository overrides never change another workspace. */
export function MergeReviewPolicyField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter) => void;
}) {
  const settings = useServerSettings((state) => state.settings);
  const bots = settings === undefined ? [] : reviewBotsOf(settings);
  const policy = charter.mergeReviewPolicy ?? "bot";
  const overrides = charter.repoMergeReviewPolicies ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="merge-review-policy">
      <Field
        label="Merge review policy"
        description={POLICY_LINE[policy]}
        keywords={["merge", "solo", "review bot", "automatic", "ci"]}
        learnMore={
          <>
            <p>
              Solo development requires passing CI and GitHub merge rules. For risky changes, have a
              fresh independent worker review and hold the merge until it is done.
            </p>
            <p>
              Automatic requires approval on the exact head when an approving review bot is
              configured; otherwise it uses solo development. Workspaces made before this policy
              existed keep their bot requirement until you change it.
            </p>
          </>
        }
      >
        <OptionGroup
          label="Merge review policy"
          options={OPTIONS}
          value={policy}
          disabled={disabled}
          onChange={(mergeReviewPolicy) => onChange({ ...charter, mergeReviewPolicy })}
        />
        <p data-testid="resolved-merge-review-policy" className="text-xs text-muted-foreground">
          Resolves to {mergeReviewPolicyOf(charter, "", bots)} now.
        </p>
      </Field>
      <Field
        label="Repository overrides"
        description="A different policy for one repository, in this workspace only."
        keywords={["override", "owner/repo", "repository policy"]}
      >
        {overrides.length > 0 && (
          <ul data-testid="repo-overrides" className="flex flex-col gap-1">
            {overrides.map((override, index) => (
              <li
                key={override.repo}
                data-testid="repo-override"
                className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{override.repo}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {mergeReviewPolicyOf(charter, override.repo, bots)}
                </span>
                <select
                  aria-label={`Policy for ${override.repo}`}
                  className={SELECT}
                  value={override.policy}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      withOverrides(
                        charter,
                        overrides.map((each, i) =>
                          i === index
                            ? { ...each, policy: event.target.value as MergeReviewPolicy }
                            : each,
                        ),
                      ),
                    )
                  }
                >
                  {OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {POLICY_LABEL[option.value]}
                    </option>
                  ))}
                </select>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove the override for ${override.repo}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      withOverrides(
                        charter,
                        overrides.filter((_, i) => i !== index),
                      ),
                    )
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AddOverride
          overrides={overrides}
          disabled={disabled}
          onAdd={(override) => onChange(withOverrides(charter, [...overrides, override]))}
        />
      </Field>
    </div>
  );
}

/** The row that adds one override: its repository and policy, checked before it is saved. */
function AddOverride({
  overrides,
  disabled,
  onAdd,
}: {
  overrides: readonly Override[];
  disabled: boolean;
  onAdd: (override: Override) => void;
}) {
  const id = useId();
  const [repo, setRepo] = useState("");
  const [policy, setPolicy] = useState<MergeReviewPolicy>("solo");
  const [error, setError] = useState<string>();
  const add = () => {
    const trimmed = repo.trim();
    const problem = overrideProblem(overrides, trimmed);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    setError(undefined);
    setRepo("");
    onAdd({ repo: trimmed, policy });
  };
  return (
    <div className="flex flex-col gap-1">
      <form
        aria-label="Add a repository override"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          id={id}
          aria-label="Repository (owner/repo)"
          className={cn(inputCls, "h-7 w-56 font-mono text-xs")}
          placeholder="owner/repo"
          spellCheck={false}
          autoComplete="off"
          value={repo}
          disabled={disabled}
          onChange={(event) => {
            setRepo(event.target.value);
            setError(undefined);
          }}
        />
        <select
          aria-label="Policy for the new override"
          className={SELECT}
          value={policy}
          disabled={disabled}
          onChange={(event) => setPolicy(event.target.value as MergeReviewPolicy)}
        >
          {OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {POLICY_LABEL[option.value]}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={disabled || repo.trim() === ""}>
          <Plus data-icon="inline-start" />
          Add override
        </Button>
      </form>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
