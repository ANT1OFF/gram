import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  Copy,
  Monitor,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { agoText, formatDay } from "@/lib/time";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { copyText } from "./copy-text";
import { phoneAccess, PhoneAccessError } from "./phone-access-api";
import { PHONE_ACCESS_KEY, TailscaleChecklist } from "./phone-access-page";
import { MachineSignIn, SignInButton } from "./machine-sign-in";
import {
  type JoinedMachine,
  type JoinLink,
  MACHINES_KEY,
  machineNeedsSignIn,
  machineSignInProblem,
  machineToolsLine,
  machinesApi,
  MachinesError,
  SshJoinError,
  type MachinesStatus,
} from "./machines-api";
import { GROUP_TITLE, SETTINGS_CARD } from "./settings-group";

export { MACHINES_KEY } from "./machines-api";

/** How many machines can join, as the server keeps them. */
export const MAX_MACHINES = 16;

/** What runs `gram-host join` from a Gram checkout, for a machine that has one. */
export const JOIN_COMMAND = "node packages/server/src/host/main.ts join";
const STATUS_COMMAND = "gram-host status";

/**
 * The one command that joins a machine: this Gram's installer, which uses or downloads the Gram
 * app there and joins with the link, handed over on stdin.
 */
export const installCommand = (link: string): string =>
  `curl -fsSL ${new URL(link).origin}/host/install | sh -s -- '${link.replaceAll("'", "")}'`;

const message = (error: unknown) =>
  error instanceof MachinesError ? error.message : "Couldn't reach Gram's server";

const platformName = (platform: string) =>
  platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;

/** How a joined machine reads in its row: waiting for you, online, or offline since it joined. */
export function machineState(machine: JoinedMachine, now = Date.now()): string {
  const joined = `Joined ${formatDay(machine.joinedAt, now)}`;
  if (!machine.confirmed) return `${joined} · waiting for you to confirm it`;
  if (machine.onlineSince === undefined) return `${joined} · offline`;
  return now - machine.onlineSince < 60_000
    ? `${joined} · online`
    : `${joined} · online for ${agoText(machine.onlineSince, now, { long: true }).replace(/ ago$/, "")}`;
}

type Pending = { readonly kind: "confirm" | "remove"; readonly machine: JoinedMachine };

/**
 * Settings → Machines: the other computers joined to this Gram, which run its work over the
 * tailnet. A machine joins with a one-time link and gets no work until its fingerprint is
 * confirmed here.
 */
export function MachinesPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending>();
  /** The machine whose Sign in terminal is open under its row. */
  const [signingIn, setSigningIn] = useState<string>();
  const [error, setError] = useState<string>();
  const status = useQuery({
    queryKey: MACHINES_KEY,
    queryFn: machinesApi.list,
    retry: false,
    // The join dialog watches for the new machine; otherwise a slow refresh keeps "online" honest.
    refetchInterval: adding ? 1500 : 10_000,
  });
  const act = async (run: () => Promise<MachinesStatus>) => {
    setError(undefined);
    try {
      queryClient.setQueryData(MACHINES_KEY, await run());
    } catch (e) {
      setError(message(e));
      void queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
    }
  };

  if (status.isPending) return <p className="text-meta text-muted-foreground">Checking…</p>;
  if (status.isError)
    return (
      <p role="alert" className="text-meta text-destructive">
        {message(status.error)}
      </p>
    );
  const machines = status.data.machines;
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="machines-joined"
      data-testid="machines"
    >
      <div className="flex items-center gap-2 px-1">
        <h3 id="machines-joined" className={GROUP_TITLE}>
          Other machines
        </h3>
        <span className="text-meta text-muted-foreground tabular-nums">
          {machines.length} of {MAX_MACHINES}
        </span>
        <Button
          size="sm"
          className="ms-auto"
          disabled={machines.length >= MAX_MACHINES}
          onClick={() => setAdding(true)}
          data-testid="machines-add"
        >
          <Plus aria-hidden />
          Add a machine
        </Button>
      </div>
      {machines.length === 0 ? (
        <p className="px-1 text-meta text-muted-foreground">
          No other machines yet. Add a Mac or Linux computer on your tailnet to run Gram&apos;s work
          there.
        </p>
      ) : (
        <div className={SETTINGS_CARD} data-testid="machines-list">
          {machines.map((machine) => (
            <MachineRow
              key={machine.id}
              machine={machine}
              now={status.dataUpdatedAt}
              onConfirm={() => setPending({ kind: "confirm", machine })}
              onRemove={() => setPending({ kind: "remove", machine })}
              signingIn={signingIn === machine.id}
              onSignIn={() => setSigningIn(machine.id)}
              onSignInClosed={() => setSigningIn(undefined)}
            />
          ))}
        </div>
      )}
      {error !== undefined && (
        <p role="alert" className="px-1 text-meta text-destructive" data-testid="machines-error">
          {error}
        </p>
      )}
      {machines.length > 0 && (
        <p className="px-1 text-meta text-muted-foreground">
          A machine runs nothing until you confirm it. Removing one forgets its key and disconnects
          it at once.
        </p>
      )}
      {adding && (
        <AddDialog
          machines={machines}
          onConfirm={(machine) => {
            setAdding(false);
            setPending({ kind: "confirm", machine });
          }}
          onClose={() => {
            setAdding(false);
            void queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
          }}
        />
      )}
      {pending?.kind === "confirm" && (
        <ConfirmDialog
          machine={pending.machine}
          onCancel={() => setPending(undefined)}
          onConfirm={async () => {
            await act(() => machinesApi.confirm(pending.machine.id));
            setPending(undefined);
          }}
        />
      )}
      {pending?.kind === "remove" && (
        <RemoveDialog
          machine={pending.machine}
          onCancel={() => setPending(undefined)}
          onConfirm={async () => {
            await act(() => machinesApi.remove(pending.machine.id));
            setPending(undefined);
          }}
        />
      )}
    </section>
  );
}

function MachineRow({
  machine,
  now,
  onConfirm,
  onRemove,
  signingIn,
  onSignIn,
  onSignInClosed,
}: {
  machine: JoinedMachine;
  now: number;
  onConfirm: () => void;
  onRemove: () => void;
  signingIn: boolean;
  onSignIn: () => void;
  onSignInClosed: () => void;
}) {
  const online = machine.confirmed && machine.onlineSince !== undefined;
  const problem = online ? machineSignInProblem(machine) : undefined;
  const tools = online ? machineToolsLine(machine) : undefined;
  return (
    <div className="flex flex-col gap-2" data-testid="machines-row">
      <div className="flex min-h-9 items-center gap-3">
        <Monitor aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-medium">
            {machine.name}
            <span className="text-meta font-normal text-muted-foreground">
              {platformName(machine.platform)}
            </span>
            {online && (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-success"
                data-testid="machines-online"
              />
            )}
          </span>
          <span className="text-meta text-muted-foreground">{machineState(machine, now)}</span>
          {tools !== undefined && (
            <span className="text-meta text-muted-foreground" data-testid="machines-tools">
              {tools}
            </span>
          )}
          {problem !== undefined && (
            <span
              className="flex items-center gap-1 text-meta text-destructive"
              data-testid="machines-sign-in-problem"
            >
              <CircleAlert aria-hidden className="size-icon-chip shrink-0" />
              {problem}
            </span>
          )}
          <span className="font-mono text-meta text-muted-foreground" title="Key fingerprint">
            {machine.fingerprint}
          </span>
        </span>
        <span className="ms-auto flex shrink-0 gap-1">
          {!machine.confirmed && (
            <Button size="sm" onClick={onConfirm}>
              Confirm
            </Button>
          )}
          {online && machineNeedsSignIn(machine) && !signingIn && (
            <SignInButton machine={machine} onClick={onSignIn} testId="machines-sign-in" />
          )}
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </span>
      </div>
      {signingIn && <MachineSignIn machine={machine} onClose={onSignInClosed} />}
    </div>
  );
}

/** An install over SSH: running, or how it ended. */
type SshRun =
  | { readonly phase: "running"; readonly host: string }
  | {
      readonly phase: "done";
      readonly host: string;
      /** What happened, for the person: joined and confirmed, or its service moved. */
      readonly said: string;
      /** What still went wrong after it joined, if anything. */
      readonly problem?: string;
      readonly output: string;
    }
  | { readonly phase: "failed"; readonly message: string; readonly output: string };

/**
 * Add over SSH: this computer runs the installer on a host it can SSH to with its keys, and the
 * machine is confirmed when the key that joined is the one the install printed. The run's state
 * lives in the dialog, so the new machine appearing, or the dialog's link expiring, mid-run doesn't
 * lose its answer.
 */
function SshJoin({
  run,
  showForm,
  onRun,
}: {
  run: SshRun | undefined;
  showForm: boolean;
  onRun: (host: string) => void;
}) {
  const { data: hosts = [] } = useQuery({
    queryKey: ["machines.sshHosts"],
    queryFn: machinesApi.sshHosts,
    retry: false,
    staleTime: 60_000,
  });
  const [target, setTarget] = useState("");
  const busy = run?.phase === "running";
  return (
    <div className="flex flex-col gap-2" data-testid="machines-ssh">
      {showForm && run?.phase !== "done" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (target.trim() !== "" && !busy) onRun(target.trim());
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-medium">Add a machine you can SSH to</span>
            <span className="text-meta text-muted-foreground">
              Gram installs it there with your SSH keys, then checks its fingerprint for you.
            </span>
          </label>
          <span className="flex gap-2">
            <input
              aria-label="SSH host"
              list="machines-ssh-hosts"
              placeholder="user@host"
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 font-mono text-meta outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={target}
              disabled={busy}
              onChange={(event) => setTarget(event.target.value)}
            />
            <datalist id="machines-ssh-hosts">
              {hosts.map((host) => (
                <option key={host} value={host} />
              ))}
            </datalist>
            <Button type="submit" size="sm" disabled={busy || target.trim() === ""}>
              {busy ? "Installing…" : "Add over SSH"}
            </Button>
          </span>
        </form>
      )}
      {busy && (
        <p className="text-meta text-muted-foreground" aria-live="polite">
          Installing on {run.host} over SSH. A first install downloads Gram there, which can take a
          few minutes.
        </p>
      )}
      {run?.phase === "done" && (
        <p className="flex items-center gap-2 font-medium" role="status">
          <CircleCheck aria-hidden className="size-icon-row text-success" />
          {run.said}
        </p>
      )}
      {(run?.phase === "failed" || (run?.phase === "done" && run.problem !== undefined)) && (
        <div role="alert" className="flex flex-col gap-1 text-meta">
          <span className="text-destructive">
            {run.phase === "failed" ? run.message : run.problem}
          </span>
          {run.output !== "" && (
            <pre className="max-h-32 overflow-auto rounded-sm bg-accent px-2 py-1 font-mono text-meta whitespace-pre-wrap text-foreground">
              {run.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Access over Tailscale, turned on from here when it is off: other machines dial the address it
 * serves on the tailnet. While Tailscale itself isn't ready, what it still needs, checked again on
 * request.
 */
function TailscaleStep({ onReady }: { onReady: () => void }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: PHONE_ACCESS_KEY,
    queryFn: phoneAccess.status,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const tailscale = status.data?.tailscale;
  const enable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await phoneAccess.enable();
      queryClient.setQueryData(PHONE_ACCESS_KEY, next);
      if (next.origin === undefined)
        setError(next.problem ?? "Access over Tailscale didn't start.");
      else onReady();
    } catch (e) {
      setError(e instanceof PhoneAccessError ? e.message : "Couldn't reach Gram's server");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {tailscale !== undefined && tailscale.state !== "ready" ? (
        <TailscaleChecklist
          state={tailscale}
          checking={status.isFetching}
          onCheck={() => void status.refetch()}
        />
      ) : (
        <Alert>
          <CircleAlert aria-hidden />
          <AlertDescription>
            Other machines reach this one over your tailnet, at the same address phone access uses.
            Turn on access over Tailscale to add one; you can turn it off again in Phone access.
          </AlertDescription>
        </Alert>
      )}
      {(error !== undefined || status.isError) && (
        <p role="alert" className="text-meta text-destructive">
          {error ?? "Couldn't read Tailscale's state."}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Close
        </Dialog.Close>
        {tailscale?.state === "ready" && (
          <Button size="sm" disabled={busy} onClick={() => void enable()}>
            {busy ? "Turning on…" : "Turn on access over Tailscale"}
          </Button>
        )}
      </div>
    </>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void copyText(text).then(() => setCopied(true));
      }}
    >
      <Copy aria-hidden />
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * Makes a join link and waits for a machine to use it: the steps to run on the new machine, the
 * link to paste there, and the new machine once it has joined.
 */
function AddDialog({
  machines,
  onConfirm,
  onClose,
}: {
  machines: ReadonlyArray<JoinedMachine>;
  onConfirm: (machine: JoinedMachine) => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState<JoinLink | "tailscale-off" | "ssh-running" | "error">();
  // A run that ends after the dialog closed mints no link nobody will see.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const [known] = useState(() => new Set(machines.map((machine) => machine.id)));
  const [now, setNow] = useState(() => Date.now());
  const [sshRun, setSshRun] = useState<SshRun>();
  const queryClient = useQueryClient();
  const mint = () => {
    setLink(undefined);
    machinesApi.joinLink().then(setLink, () => setLink("error"));
  };
  const runSsh = async (host: string) => {
    setSshRun({ phase: "running", host });
    try {
      const next = await machinesApi.sshJoin(host);
      queryClient.setQueryData(MACHINES_KEY, { machines: next.machines });
      setSshRun({
        phase: "done",
        host,
        said:
          next.joined === "rejoined"
            ? `${host} had already joined; its service moved to this release.`
            : `${host} joined, and its fingerprint matched.`,
        ...(next.problem === undefined ? {} : { problem: next.problem }),
        output: next.output,
      });
    } catch (e) {
      setSshRun({
        phase: "failed",
        message: message(e),
        output: e instanceof SshJoinError ? e.output : "",
      });
      // The install used its own link, which replaced this dialog's: the command gets a new one.
      // One refused because another was running replaced nothing.
      if (open.current && !(e instanceof SshJoinError && e.busy)) mint();
    }
  };
  useEffect(() => {
    // A newer link replaces an older one on the server, so only the last answer counts.
    let live = true;
    machinesApi.joinLink().then(
      (next) => live && setLink(next),
      () => live && setLink("error"),
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const joined = machines.find((machine) => !known.has(machine.id));
  const expired = typeof link === "object" && now >= link.expiresAt;
  const left = typeof link === "object" ? Math.max(0, link.expiresAt - now) : 0;
  const countdown = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;

  return (
    <DialogShell testId="machines-add-dialog" title="Add a machine" onClose={onClose}>
      {(sshRun !== undefined || typeof link === "object") && (
        <SshJoin
          run={sshRun}
          showForm={joined === undefined && !expired}
          onRun={(host) => void runSsh(host)}
        />
      )}
      {sshRun?.phase === "running" ? null : sshRun?.phase === "done" ? (
        <div className="flex justify-end">
          <Dialog.Close render={<Button type="button" size="sm" />}>Done</Dialog.Close>
        </div>
      ) : link === "tailscale-off" ? (
        <TailscaleStep onReady={mint} />
      ) : link === "ssh-running" ? (
        <>
          <p className="text-muted-foreground">
            Gram is adding a machine over SSH, which uses the one join link. Try again once that
            finishes.
          </p>
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Close
            </Dialog.Close>
            <Button size="sm" onClick={mint}>
              Try again
            </Button>
          </div>
        </>
      ) : link === "error" ? (
        <>
          <p role="alert" className="text-meta text-destructive">
            Couldn&apos;t make a join link.
          </p>
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Close
            </Dialog.Close>
            <Button size="sm" onClick={mint}>
              Try again
            </Button>
          </div>
        </>
      ) : joined !== undefined ? (
        <>
          <p className="flex items-center gap-2 font-medium" data-testid="machines-joined-new">
            <CircleCheck aria-hidden className="size-icon-row text-success" />
            {joined.name} joined
          </p>
          <p className="text-muted-foreground">
            Confirm it once its fingerprint matches the one it printed. Until then it runs nothing.
          </p>
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Later
            </Dialog.Close>
            <Button size="sm" onClick={() => onConfirm(joined)}>
              Check fingerprint
            </Button>
          </div>
        </>
      ) : expired ? (
        <>
          <p className="text-muted-foreground">
            This link expired after 15 minutes without being used, so it no longer works.
          </p>
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Close
            </Dialog.Close>
            <Button size="sm" onClick={mint}>
              <RefreshCw aria-hidden />
              New link
            </Button>
          </div>
        </>
      ) : (
        <>
          <ol className="flex list-decimal flex-col gap-3 ps-5 text-muted-foreground">
            <li>
              Or, on the other machine, with Tailscale connected, run this in a terminal. It uses
              the Gram app there, or downloads it, and runs in the background from then on.
              <span className="mt-1.5 flex items-center gap-2">
                {link === undefined ? (
                  <span className="h-7 flex-1 animate-pulse rounded-sm bg-accent" />
                ) : (
                  <>
                    <code
                      className="min-w-0 flex-1 truncate rounded-sm bg-accent px-2 py-1 font-mono text-meta text-foreground"
                      data-testid="machines-command"
                    >
                      {installCommand(link.url).replace(/#code=[^']*/, "#code=…")}
                    </code>
                    <CopyButton text={installCommand(link.url)} label="Copy" />
                  </>
                )}
              </span>
              {link !== undefined && (
                <span className="mt-1.5 flex flex-wrap items-center gap-x-1 text-meta">
                  From a Gram checkout instead: run{" "}
                  <code className="font-mono">{JOIN_COMMAND}</code> and paste the link.
                  <CopyButton text={link.url} label="Copy link" />
                </span>
              )}
            </li>
            <li>
              Once it joins, check the fingerprint it printed against the one Gram shows, and
              confirm it.
            </li>
          </ol>
          {link !== undefined && (
            <p className="text-center text-meta text-muted-foreground" aria-live="polite">
              Waiting for the machine · expires in <span className="tabular-nums">{countdown}</span>
            </p>
          )}
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertDescription className="text-meta">
              The link works once, for 15 minutes. Paste it only on your own machine; a machine that
              joins with it still needs you to confirm it here.
            </AlertDescription>
          </Alert>
          <div className="flex justify-end">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </Dialog.Close>
          </div>
        </>
      )}
    </DialogShell>
  );
}

function ConfirmDialog({
  machine,
  onCancel,
  onConfirm,
}: {
  machine: JoinedMachine;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DialogShell testId="machines-confirm" title={`Confirm ${machine.name}?`} onClose={onCancel}>
      <p className="text-muted-foreground">
        Check that <span className="font-medium text-foreground">{machine.name}</span> printed this
        fingerprint when it joined. Run <code className="font-mono">{STATUS_COMMAND}</code> there to
        see it again.
      </p>
      <p
        className="rounded-md bg-accent px-3 py-2 text-center font-mono text-foreground select-all"
        data-testid="machines-fingerprint"
      >
        {machine.fingerprint}
      </p>
      <p className="text-meta text-muted-foreground">
        If they don&apos;t match, another machine used the link: remove it instead.
      </p>
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          They match
        </Button>
      </div>
    </DialogShell>
  );
}

function RemoveDialog({
  machine,
  onCancel,
  onConfirm,
}: {
  machine: JoinedMachine;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DialogShell testId="machines-remove" title={`Remove ${machine.name}?`} onClose={onCancel}>
      <p className="text-muted-foreground">
        Gram forgets its key and disconnects it at once. To use it again, add it again and run{" "}
        <code className="font-mono">{STATUS_COMMAND.replace(/status$/, "leave")}</code> there first.
      </p>
      <div className="flex justify-end gap-2">
        <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
          Cancel
        </Dialog.Close>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm().finally(() => setBusy(false));
          }}
        >
          Remove
        </Button>
      </div>
    </DialogShell>
  );
}
