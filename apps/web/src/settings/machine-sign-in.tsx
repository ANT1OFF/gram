import { HostId, type TerminalId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { TerminalView } from "@/panels/terminal/terminal-view";

import {
  type JoinedMachine,
  MACHINES_KEY,
  machineSignInProblem,
  machinesApi,
  MachinesError,
} from "./machines-api";

/** The grid the sign-in terminal opens at, before it fits its box. */
const COLS = 100;
const ROWS = 16;

type Stage =
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly terminalId: TerminalId }
  | { readonly kind: "checking"; readonly terminalId: TerminalId }
  | { readonly kind: "done"; readonly terminalId: TerminalId; readonly problem?: string }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Signs `machine`'s own Claude Code in: a terminal on that machine, in Gram, running its own
 * `claude auth login`. The sign-in page opens from the link it prints, in this computer's browser;
 * once the command ends the machine is asked again and its row says how it went. Gram only starts
 * the CLI: what it stores stays on that machine.
 */
export function MachineSignIn({
  machine,
  onClose,
}: {
  machine: JoinedMachine;
  onClose: () => void;
}) {
  // Each run is its own terminal: Run again starts a fresh one.
  const [attempt, setAttempt] = useState(0);
  return (
    <SignInRun
      key={attempt}
      machine={machine}
      onClose={onClose}
      onAgain={() => setAttempt((n) => n + 1)}
    />
  );
}

function SignInRun({
  machine,
  onClose,
  onAgain,
}: {
  machine: JoinedMachine;
  onClose: () => void;
  onAgain: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>({ kind: "opening" });
  const opened = useRef<TerminalId | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api
      .terminalOpen({ signIn: HostId.make(machine.id), cols: COLS, rows: ROWS })
      .then((terminal) => {
        opened.current = terminal.terminalId;
        if (live) setStage({ kind: "open", terminalId: terminal.terminalId });
        else void api.terminalClose(terminal.terminalId).catch(() => {});
      })
      .catch((error: unknown) => {
        if (live) setStage({ kind: "failed", message: errorMessage(error) });
      });
    return () => {
      live = false;
      // Closing the panel stops a sign-in still waiting; one that ended is already gone.
      if (opened.current !== undefined) void api.terminalClose(opened.current).catch(() => {});
      opened.current = undefined;
    };
  }, [api, machine.id]);

  const recheck = async (terminalId: TerminalId) => {
    setStage({ kind: "checking", terminalId });
    try {
      const status = await machinesApi.checkSignIn(machine.id);
      queryClient.setQueryData(MACHINES_KEY, status);
      const now = status.machines.find((each) => each.id === machine.id);
      const problem =
        now === undefined
          ? "The machine is no longer joined."
          : now.claudeSignIn === "signedIn"
            ? undefined
            : (machineSignInProblem(now) ??
              `Couldn't tell whether ${machine.name} is signed in now.`);
      setStage({ kind: "done", terminalId, ...(problem === undefined ? {} : { problem }) });
    } catch (error) {
      setStage({
        kind: "done",
        terminalId,
        problem: error instanceof MachinesError ? error.message : "Couldn't reach Gram's server",
      });
    }
  };

  const terminalId =
    stage.kind === "opening" || stage.kind === "failed" ? undefined : stage.terminalId;
  return (
    <div className="flex flex-col gap-2" data-testid="machine-sign-in">
      <p className="text-meta text-muted-foreground">
        {`Signing in Claude Code on ${machine.name}. Open the link it prints to sign in in this computer's browser; if it asks for a code, paste it here.`}
      </p>
      {terminalId !== undefined && (
        <div className="relative h-72 overflow-hidden rounded-md border border-border">
          <TerminalView
            terminalId={terminalId}
            active
            script="Sign-in"
            onRestart={onAgain}
            onExit={() => {
              opened.current = undefined;
              void recheck(terminalId);
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-meta">
        <span
          role="status"
          className={
            stage.kind === "failed" || (stage.kind === "done" && stage.problem !== undefined)
              ? "text-destructive"
              : "text-muted-foreground"
          }
          data-testid="machine-sign-in-status"
        >
          {stage.kind === "opening"
            ? `Opening a terminal on ${machine.name}…`
            : stage.kind === "open"
              ? "Waiting for the sign-in to finish."
              : stage.kind === "checking"
                ? `Checking ${machine.name}…`
                : stage.kind === "failed"
                  ? stage.message
                  : (stage.problem ?? `Claude Code is signed in on ${machine.name}.`)}
        </span>
        <Button size="xs" variant="outline" className="ms-auto" onClick={onClose}>
          {stage.kind === "done" && stage.problem === undefined ? "Done" : "Close"}
        </Button>
      </div>
    </div>
  );
}
