import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  Copy,
  Monitor,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Hint } from "@/components/hint";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDay } from "@/lib/time";
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
import {
  healthHint,
  type MachineHealth,
  machineHealth,
  machineUpdateLine,
  updating,
} from "./machine-status";
import { machineUpdatesOn, type Settings } from "@gram/contracts";
import { useServerSettings } from "@/settings-sync/store";
import { Toggle } from "./fields";
import { useSaveSettings } from "./use-save-settings";
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

/** How a joined machine reads in its row: waiting for you, online, offline, or needing an update. */
export function machineState(
  machine: JoinedMachine,
  now = Date.now(),
  status: Pick<MachinesStatus, "release" | "protocol"> = {},
): string {
  return `Joined ${formatDay(machine.joinedAt, now)} · ${machineHealth(machine, status, now).label}`;
}

type Pending = {
  readonly kind: "confirm" | "remove" | "update";
  readonly machine: JoinedMachine;
};

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
    // The join dialog watches for the new machine, and a row its update; otherwise a slow refresh
    // keeps "online" honest.
    refetchInterval: (query) =>
      adding || query.state.data?.machines.some(updating) === true ? 1500 : 10_000,
  });
  const settings = useServerSettings((s) => s.settings);
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
  const healthOf = (machine: JoinedMachine) =>
    machineHealth(machine, status.data, status.dataUpdatedAt);
  /** Confirmed machines behind this Gram, which an Update moves to its release. */
  const behind = machines.filter(
    (machine) => machine.confirmed && healthOf(machine).update !== undefined,
  );
  const update = (machine: JoinedMachine) => {
    // A host that updates itself starts at once, and its row shows how it goes.
    if (machine.selfUpdate === true) void act(() => machinesApi.update(machine.id));
    else setPending({ kind: "update", machine });
  };
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
        {behind.length > 1 && status.data.release !== undefined && (
          <Hint
            label={`Update the machines that can update themselves to ${status.data.release}, each once it's idle`}
            render={
              <Button
                size="sm"
                variant="outline"
                className="ms-auto"
                disabled={behind.every(
                  (machine) => machine.selfUpdate !== true || updating(machine),
                )}
                onClick={() => void act(() => machinesApi.updateAll())}
                data-testid="machines-update-all"
              />
            }
          >
            <CircleArrowUp aria-hidden />
            Update all
          </Hint>
        )}
        <Button
          size="sm"
          className={behind.length > 1 && status.data.release !== undefined ? "" : "ms-auto"}
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
              health={healthOf(machine)}
              now={status.dataUpdatedAt}
              onConfirm={() => setPending({ kind: "confirm", machine })}
              onRemove={() => setPending({ kind: "remove", machine })}
              onUpdate={() => update(machine)}
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
      {machines.length > 0 && settings !== undefined && (
        <MachineUpdatesToggle settings={settings} />
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
      {pending?.kind === "update" && (
        <UpdateDialog
          machine={pending.machine}
          health={machineHealth(pending.machine, status.data, status.dataUpdatedAt)}
          command={status.data.updateCommand}
          onUpdated={(next) => queryClient.setQueryData(MACHINES_KEY, next)}
          onClose={() => {
            setPending(undefined);
            void queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
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

/** Settings → Machines' switch for updating joined machines on their own, on until turned off. */
function MachineUpdatesToggle({ settings }: { settings: Settings }) {
  const saveSettings = useSaveSettings();
  const [error, setError] = useState<string>();
  return (
    <div className={SETTINGS_CARD}>
      <Toggle
        label="Update machines automatically"
        description="When Gram updates, each joined machine moves to the same release once it has no running turn or busy terminal."
        keywords={["update", "upgrade", "release", "gram-host", "automatic"]}
        checked={machineUpdatesOn(settings)}
        error={error}
        onChange={(machines) => {
          setError(undefined);
          saveSettings({ updates: { machines } }).catch((e: unknown) =>
            setError(e instanceof Error ? e.message : "Couldn't save the setting"),
          );
        }}
      />
    </div>
  );
}

function MachineRow({
  machine,
  health,
  now,
  onConfirm,
  onRemove,
  onUpdate,
  signingIn,
  onSignIn,
  onSignInClosed,
}: {
  machine: JoinedMachine;
  health: MachineHealth;
  now: number;
  onConfirm: () => void;
  onRemove: () => void;
  onUpdate: () => void;
  signingIn: boolean;
  onSignIn: () => void;
  onSignInClosed: () => void;
}) {
  const online = health.tone === "online";
  const hint = healthHint(health);
  // Any confirmed machine behind this Gram: over its own connection when its host updates itself,
  // otherwise by the installer.
  const updateTo = machine.confirmed ? health.update?.to : undefined;
  const updateLine = machineUpdateLine(machine, now);
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
          <span className="text-meta text-muted-foreground">
            Joined {formatDay(machine.joinedAt, now)} ·{" "}
            {hint === undefined ? (
              <span data-testid="machines-state">{health.label}</span>
            ) : (
              <Hint
                label={hint}
                side="bottom"
                render={
                  <span
                    // Focusable, so the reason is there by keyboard too.
                    tabIndex={0}
                    aria-description={hint}
                    data-testid="machines-state"
                    className="inline-flex items-center gap-1 rounded-sm align-bottom whitespace-nowrap outline-none focus-visible:focus-ring"
                  />
                }
              >
                {health.label}
                {/* Neutral: the glyph's shape says it, as for any caution that isn't a setting's. */}
                {health.update !== undefined ? (
                  <CircleArrowUp aria-hidden className="size-icon-chip" />
                ) : (
                  <CircleAlert aria-hidden className="size-icon-chip" />
                )}
              </Hint>
            )}
          </span>
          {tools !== undefined && (
            <span className="text-meta text-muted-foreground" data-testid="machines-tools">
              {tools}
            </span>
          )}
          {updateLine !== undefined && (
            <span
              className={`flex items-center gap-1 text-meta ${updateLine.tone === "failed" ? "text-destructive" : "text-muted-foreground"}`}
              data-testid="machines-update-state"
              aria-live="polite"
            >
              {updateLine.tone === "failed" ? (
                <CircleAlert aria-hidden className="size-icon-chip shrink-0" />
              ) : updateLine.tone === "done" ? (
                <CircleCheck aria-hidden className="size-icon-chip shrink-0 text-success" />
              ) : (
                <RefreshCw
                  aria-hidden
                  className="size-icon-chip shrink-0 motion-safe:animate-spin"
                />
              )}
              {updateLine.text}
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
          {updateTo !== undefined && (
            <Hint
              label={`Update ${machine.name} to ${updateTo}`}
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label={`Update ${machine.name} to ${updateTo}`}
                  disabled={updating(machine)}
                  onClick={onUpdate}
                  data-testid="machines-update"
                />
              }
            >
              <CircleArrowUp />
            </Hint>
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

/**
 * Updates a joined machine to this Gram's release: over SSH again where Gram added it, otherwise
 * the one command to run there, which moves its service to the release and keeps the join.
 */
function UpdateDialog({
  machine,
  health,
  command,
  onUpdated,
  onClose,
}: {
  machine: JoinedMachine;
  health: MachineHealth;
  command: string | undefined;
  onUpdated: (next: MachinesStatus) => void;
  onClose: () => void;
}) {
  const [run, setRun] = useState<SshRun>();
  const target = machine.sshTarget;
  const to = health.update?.to;
  const update = async () => {
    if (target === undefined) return;
    setRun({ phase: "running", host: target });
    try {
      const next = await machinesApi.update(machine.id);
      onUpdated(next);
      setRun({
        phase: "done",
        host: target,
        said: `${machine.name} moved to ${to ?? "this Gram's release"}. It dials in again in a moment.`,
        output: next.output,
      });
    } catch (e) {
      setRun({
        phase: "failed",
        message: message(e),
        output: e instanceof SshJoinError ? e.output : "",
      });
    }
  };
  return (
    <DialogShell
      testId="machines-update-dialog"
      title={`Update ${machine.name}${to === undefined ? "" : ` to ${to}`}?`}
      onClose={onClose}
    >
      {health.why !== undefined && <p className="text-muted-foreground">{health.why}</p>}
      {target !== undefined ? (
        <>
          {run === undefined && (
            <p className="text-muted-foreground">
              Gram added it over SSH, so it runs that install again on{" "}
              <code className="font-mono">{target}</code>: it moves the service to this release and
              keeps the join.
            </p>
          )}
          {run?.phase === "running" && (
            <p className="text-meta text-muted-foreground" aria-live="polite">
              Updating {machine.name} over SSH. Downloading Gram there can take a few minutes.
            </p>
          )}
          {run?.phase === "done" && (
            <p className="flex items-center gap-2 font-medium" role="status">
              <CircleCheck aria-hidden className="size-icon-row text-success" />
              {run.said}
            </p>
          )}
          {run?.phase === "failed" && (
            <div role="alert" className="flex flex-col gap-1 text-meta">
              <span className="text-destructive">{run.message}</span>
              {run.output !== "" && (
                <pre className="max-h-32 overflow-auto rounded-sm bg-accent px-2 py-1 font-mono text-meta whitespace-pre-wrap text-foreground">
                  {run.output}
                </pre>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              {run?.phase === "done" ? "Done" : "Cancel"}
            </Dialog.Close>
            {run?.phase !== "done" && (
              <Button
                size="sm"
                disabled={run?.phase === "running" || command === undefined}
                onClick={() => void update()}
              >
                {run?.phase === "running" ? "Updating…" : "Update over SSH"}
              </Button>
            )}
          </div>
        </>
      ) : command === undefined ? (
        <>
          <p className="text-muted-foreground">
            Turn on access over Tailscale in Phone access first: the machine updates from this
            Gram&apos;s address on your tailnet.
          </p>
          <div className="flex justify-end">
            <Dialog.Close render={<Button type="button" size="sm" />}>Close</Dialog.Close>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            On {machine.name}, run this in a terminal. It moves the service to this release and
            keeps the join, so there is nothing to confirm again.
          </p>
          <span className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 rounded-sm bg-accent px-2 py-1 font-mono text-meta break-all text-foreground select-all"
              data-testid="machines-update-command"
            >
              {command}
            </code>
            <CopyButton text={command} label="Copy" />
          </span>
          <p className="text-meta text-muted-foreground">
            If it says the machine hasn&apos;t joined, remove it here and add it again.
          </p>
          <div className="flex justify-end">
            <Dialog.Close render={<Button type="button" size="sm" />}>Done</Dialog.Close>
          </div>
        </>
      )}
    </DialogShell>
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
