import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Server } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { DialogShell } from "@/thread/dialog-shell";
import { MachineSignIn } from "@/settings/machine-sign-in";
import {
  type JoinedMachine,
  MACHINES_KEY,
  machineSignInProblem,
  machinesApi,
} from "@/settings/machines-api";

/** The picker's value for this machine. */
const THIS_MACHINE = "__this__";

/**
 * The confirmed joined machines, refreshed while a form shows them: none where they can't be listed
 * (a paired phone) or before one is joined.
 */
export function useJoinedMachines(): readonly JoinedMachine[] | undefined {
  const { data } = useQuery({
    queryKey: MACHINES_KEY,
    queryFn: machinesApi.list,
    retry: false,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  return data === undefined ? undefined : data.machines.filter((m) => m.confirmed);
}

/** What stops a start on `machine` now: it is offline, or its Claude Code can't start sessions. */
export const machineBlocker = (machine: JoinedMachine): string | undefined =>
  machine.onlineSince === undefined
    ? `${machine.name} is offline. Start Gram's host there, or pick another machine.`
    : machineSignInProblem(machine);

/** The muted words after a machine's name in the menu. */
const stateOf = (machine: JoinedMachine): string | undefined =>
  machine.onlineSince === undefined
    ? "offline"
    : machineSignInProblem(machine) !== undefined
      ? "not signed in"
      : undefined;

/**
 * Where the new thread runs: this machine, or a confirmed joined one. A chip beside the folder or
 * repository, shown only once a machine is joined. A pick of one since removed is dropped, so
 * nothing unseen goes on the request.
 */
export function MachinePicker({
  machines,
  value,
  onChange,
}: {
  machines: readonly JoinedMachine[] | undefined;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const gone =
    value !== undefined && machines !== undefined && !machines.some((m) => m.id === value);
  useEffect(() => {
    if (gone) onChange(undefined);
  }, [gone, onChange]);
  if (machines === undefined || machines.length === 0) return null;
  const picked = machines.find((m) => m.id === value);
  const items = [
    { value: THIS_MACHINE, label: "This machine" },
    ...machines.map((m) => ({ value: m.id, label: m.name })),
  ];
  const pickedState = picked === undefined ? undefined : stateOf(picked);
  return (
    <Select
      value={picked?.id ?? THIS_MACHINE}
      items={items}
      onValueChange={(next) => {
        if (next !== null) onChange(next === THIS_MACHINE ? undefined : next);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={
          picked === undefined
            ? "Machine: this machine"
            : `Machine: ${picked.name}${pickedState === undefined ? "" : `, ${pickedState}`}`
        }
        title={pickedState === undefined ? "Machine" : `Machine · ${pickedState}`}
        className="h-7 max-w-48 text-meta"
        data-testid="where-machine"
      >
        <Server aria-hidden className="size-icon-row text-muted-foreground" />
        <span className="truncate">{picked?.name ?? "This machine"}</span>
        {pickedState !== undefined && (
          <CircleAlert
            aria-hidden
            data-testid="where-machine-problem"
            className="size-icon-chip text-destructive"
          />
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={THIS_MACHINE}>This machine</SelectItem>
        {machines.map((m) => {
          const state = stateOf(m);
          return (
            <SelectItem key={m.id} value={m.id}>
              <span className="min-w-0 truncate">{m.name}</span>
              {state !== undefined && (
                <span className="text-meta text-muted-foreground">{state}</span>
              )}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Why the picked machine can't take the thread now, said before it starts rather than after, with
 * the fixes: Sign in (the same terminal as Settings → Machines) and Check again.
 */
export function MachineNote({ machine }: { machine: JoinedMachine | undefined }) {
  const queryClient = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);
  const [checking, setChecking] = useState(false);
  if (machine === undefined) return null;
  const blocker = machineBlocker(machine);
  const signIn = machine.onlineSince !== undefined && blocker !== undefined;
  return (
    <>
      <span
        role={blocker === undefined ? undefined : "alert"}
        data-testid="machine-note"
        className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground"
      >
        {blocker === undefined ? (
          `The thread runs on ${machine.name}, in a new worktree of its own clone.`
        ) : (
          <>
            <span className="flex items-center gap-1 text-destructive">
              <CircleAlert aria-hidden className="size-icon-chip shrink-0" />
              {blocker}
            </span>
            {signIn && (
              <Button
                type="button"
                size="xs"
                onClick={() => setSigningIn(true)}
                data-testid="machine-note-sign-in"
              >
                Sign in
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                try {
                  queryClient.setQueryData(
                    MACHINES_KEY,
                    signIn ? await machinesApi.checkSignIn(machine.id) : await machinesApi.list(),
                  );
                } catch {
                  void queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
                } finally {
                  setChecking(false);
                }
              }}
            >
              {checking ? "Checking…" : "Check again"}
            </Button>
          </>
        )}
      </span>
      {signingIn && (
        <DialogShell
          testId="machine-sign-in-dialog"
          title={`Sign in on ${machine.name}`}
          onClose={() => setSigningIn(false)}
          className="w-[min(48rem,90vw)]"
        >
          <MachineSignIn machine={machine} onClose={() => setSigningIn(false)} />
        </DialogShell>
      )}
    </>
  );
}
