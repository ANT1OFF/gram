import { CircleAlert, CircleCheck, ExternalLink, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { type JoinedMachine, machinesApi, MachinesError, type TokenRun } from "./machines-api";

const message = (error: unknown) =>
  error instanceof MachinesError ? error.message : "Couldn't reach Gram's server";

/** Where a person revokes a `claude setup-token` token; deleting it on a machine doesn't. */
export const REVOKE_AT = "claude.ai → Settings → Claude Code";

/** The machines a token can be sent to now: confirmed and online. */
export const tokenTargets = (machines: ReadonlyArray<JoinedMachine>) =>
  machines.filter((machine) => machine.confirmed && machine.onlineSince !== undefined);

type Phase =
  | { readonly step: "consent" }
  | { readonly step: "run"; readonly captureId: string; readonly run: TokenRun };

/**
 * Use a token from this Mac: the consent dialog for `claude setup-token`, then its run. Nothing
 * starts until the person ticks the machines and agrees; only the one they began from is ticked.
 */
export function TokenDialog({
  machine,
  machines,
  onClose,
}: {
  /** The machine whose row it was opened from. */
  machine: JoinedMachine;
  machines: ReadonlyArray<JoinedMachine>;
  onClose: () => void;
}) {
  const targets = tokenTargets(machines);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set([machine.id]));
  const [phase, setPhase] = useState<Phase>({ step: "consent" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const names = new Map(machines.map((m) => [m.id, m.name] as const));

  const captureId = phase.step === "run" ? phase.captureId : undefined;
  const state = phase.step === "run" ? phase.run.state : undefined;
  // Polls the run while it waits for the token or sends it.
  useEffect(() => {
    if (captureId === undefined || (state !== "waiting" && state !== "sending")) return;
    let stopped = false;
    const timer = setInterval(() => {
      machinesApi.claudeToken
        .status(captureId)
        .then((run) => {
          if (!stopped) setPhase({ step: "run", captureId, run });
        })
        .catch((e: unknown) => {
          if (!stopped) setError(message(e));
        });
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [captureId, state]);

  const close = () => {
    // A run still waiting for its token stops with the dialog.
    if (captureId !== undefined && state === "waiting")
      void machinesApi.claudeToken.cancel(captureId);
    onClose();
  };

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const id = await machinesApi.claudeToken.start([...picked]);
      setPhase({ step: "run", captureId: id, run: { state: "waiting", asksForCode: false } });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    if (captureId === undefined || code.trim() === "") return;
    setError(undefined);
    try {
      await machinesApi.claudeToken.code(captureId, code.trim());
      setCode("");
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <DialogShell testId="machines-token" title="Use a Claude token from this Mac" onClose={close}>
      {phase.step === "consent" ? (
        <>
          <p className="text-muted-foreground">
            Gram runs <code className="font-mono">claude setup-token</code> on this Mac. You approve
            it in your browser, and Claude Code prints a token that signs in to your subscription
            for one year.
          </p>
          <ul className="flex list-disc flex-col gap-1.5 ps-5 text-meta text-muted-foreground">
            <li>
              Gram reads the token from that command&apos;s output on this Mac. It isn&apos;t shown,
              saved here, or logged.
            </li>
            <li>
              It is sent only to the machines you tick, over each one&apos;s own connection to this
              Gram through Tailscale.
            </li>
            <li>
              Each keeps it in its gram-host folder, readable only by your user there, and uses it
              for the Claude sessions Gram starts on it, in place of that machine&apos;s own
              sign-in.
            </li>
            <li>
              <span className="text-foreground">Forget token</span> or{" "}
              <span className="text-foreground">Remove</span>, in the machine&apos;s ⋯ menu, deletes
              it from the machine.
            </li>
          </ul>
          <fieldset className="flex flex-col gap-1.5" data-testid="machines-token-targets">
            <legend className="mb-1 font-medium">Send it to</legend>
            {targets.map((target) => (
              <label key={target.id} className="flex h-7 items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(target.id)}
                  onChange={(event) => {
                    const next = new Set(picked);
                    if (event.target.checked) next.add(target.id);
                    else next.delete(target.id);
                    setPicked(next);
                  }}
                />
                {target.name}
              </label>
            ))}
            {targets.length === 0 && (
              <p className="text-meta text-muted-foreground">
                No machine is online. A token goes only to a machine that is online now.
              </p>
            )}
          </fieldset>
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertDescription className="text-meta">
              Deleting the token doesn&apos;t revoke it, and anyone who has it can use your
              subscription until it expires. Revoke it at {REVOKE_AT}.
            </AlertDescription>
          </Alert>
          {error !== undefined && (
            <p role="alert" className="text-meta text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </Dialog.Close>
            <Button
              size="sm"
              disabled={busy || picked.size === 0 || ![...picked].every((id) => names.has(id))}
              onClick={() => void start()}
              data-testid="machines-token-start"
            >
              Run setup-token
            </Button>
          </div>
        </>
      ) : (
        <RunView
          run={phase.run}
          names={names}
          code={code}
          onCode={setCode}
          onSendCode={() => void sendCode()}
          onClose={close}
          error={error}
        />
      )}
    </DialogShell>
  );
}

function RunView({
  run,
  names,
  code,
  onCode,
  onSendCode,
  onClose,
  error,
}: {
  run: TokenRun;
  names: ReadonlyMap<string, string>;
  code: string;
  onCode: (code: string) => void;
  onSendCode: () => void;
  onClose: () => void;
  error: string | undefined;
}) {
  return (
    <>
      {run.state === "waiting" && (
        <>
          <p className="text-muted-foreground" aria-live="polite">
            Approve it in the browser window Claude Code opened. This waits up to 10 minutes.
          </p>
          {run.signInLink !== undefined && (
            <a
              href={run.signInLink}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 text-meta text-foreground underline underline-offset-2"
            >
              <ExternalLink aria-hidden className="size-icon-row" />
              Open the sign-in page again
            </a>
          )}
          {run.asksForCode && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSendCode();
              }}
            >
              <input
                aria-label="Code from the sign-in page"
                placeholder="Code from the sign-in page"
                autoComplete="off"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 font-mono text-meta outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={code}
                onChange={(event) => onCode(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={code.trim() === ""}>
                Send code
              </Button>
            </form>
          )}
        </>
      )}
      {run.state === "sending" && (
        <p className="text-muted-foreground" aria-live="polite">
          Sending the token…
        </p>
      )}
      {run.state === "done" && (
        <ul className="flex flex-col gap-1.5" data-testid="machines-token-results">
          {run.results.map((result) => (
            <li key={result.id} className="flex items-start gap-2">
              {result.ok ? (
                <CircleCheck aria-hidden className="mt-0.5 size-icon-row shrink-0 text-success" />
              ) : (
                <CircleAlert
                  aria-hidden
                  className="mt-0.5 size-icon-row shrink-0 text-destructive"
                />
              )}
              <span className="flex flex-col">
                <span className="font-medium">{names.get(result.id) ?? "A machine"}</span>
                <span className="text-meta text-muted-foreground">
                  {result.ok
                    ? "Signed in with the token. Its new Claude sessions use it."
                    : (result.message ?? "It didn't take the token.")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {run.state === "failed" && (
        <p role="alert" className="text-meta text-destructive">
          {run.message}
        </p>
      )}
      {run.state === "cancelled" && (
        <p className="text-muted-foreground">Stopped. Nothing was sent.</p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {run.state === "waiting" ? "Cancel" : "Close"}
        </Button>
      </div>
    </>
  );
}
