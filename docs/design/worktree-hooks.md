# Worktree setup and resume

[Worktree hooks](../AGENTS_AND_FEATURES.md#worktree-setup-and-resume-hooks)
prepare thread worktrees on the machine that will use them.

## Source and lifecycle

Gram records a checkout generation and its initial Git revision on physical creation.
Setup uses that revision. Resume reads the committed HEAD at activation. The resolver uses
the Git tree and executable blob, with replacement objects and lazy fetching disabled.
Native `.gram` hooks take precedence over Amp's optional `.agents` paths. A preferred
path with unsuitable contents is reported and blocks fallback. The host stages the verified
bytes in private state and runs the script in the checkout.

The thread stores the latest result for a generation and phase, alongside bounded text output.
Once started, setup is not replayed after an ambiguous interruption. A recreated checkout has
a new generation. A cold wake and a session start on the same activation share one resume.
A warm wake runs resume before delivering the notice. Reattachment to a still-running session,
ordinary follow-up turns and opening the transcript do not trigger it. Setup failures reach the
worker through server-authored context on its first brief, with raw output available in the thread.

## Trust and machine placement

Personal hosts require project folder trust and an explicit decision for new hook content. The
record is scoped to the user, host, repository, phase, path and fingerprint. Only the local Gram
app can answer the current card. Paired browsers can view it. Approval previews the committed
script and scripts with invisible formatting are refused. The host rechecks the revision and
fingerprint before execution. A declined hook or unavailable consent is recorded as skipped.

The environment owns system tools, network and credentials. Repository hooks prepare
checkout-local dependencies and files with the tools the environment makes available.
Both setup and resume use a small allowlist of child environment values and closed stdin.
On a personal machine the hook still has the account's operating-system permissions.
Embedding hosts can opt in to execution and keep it inside their network, filesystem and
identity rules. [Hosted hook contract](../EMBEDDING.md#worktree-hooks-in-an-environment)

## Prepared setup

Preparation uses the same hook under equivalent environment policy. Its initial key includes
the committed tree, hook fingerprint, platform and environment and policy revisions inside the
authorized repository and workspace scope. A provider can add a narrower input definition
only if it covers every input the hook consumes, including its lockfiles and codegen sources.

Gram defines the response and accepts a matching, unexpired result from a trusted provider
adapter after it has applied the outputs to the target checkout. A missing or stale result
leaves normal setup available. Provider builds and artifact storage are a separate integration.
Resume continues to run on worker activation.

## Local merge checks

The optional `project.localCheck.setup` value `{ "source": "repository" }` resolves the
same executable hook inside the merge check's isolated checkout. Legacy shell setup
commands keep their original runner and a cleared value means the check has no setup.
The check still qualifies the exact PR head, base and merged tree. Repository setup adds
its runner version to the check identity, and a pass records the approved fingerprint.
For a selected-source check, the hook's path, executable mode and Git blob must be in the
approved selection. An omitted preferred hook fails before its bytes are read.

On a joined machine the host first returns the hook preview from its isolated merge.
The control plane gets consent and sends the approved revision and fingerprint back.
The host rebuilds and revalidates the same merge before running the hook. An older host
must be updated to accept the repository setup option. Provisioned machines qualify via CI
and GitHub rules. The host also enforces its hosted hook policy on check requests. Gram never treats a hosted
prepared artifact or worker setup result as merge qualification.
