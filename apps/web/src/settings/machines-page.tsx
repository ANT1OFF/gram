import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleAlert,
  CircleCheck,
  Copy,
  Monitor,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { agoText, formatDay } from "@/lib/time";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { copyText } from "./copy-text";
import {
  type JoinedMachine,
  type JoinLink,
  machinesApi,
  MachinesError,
  type MachinesStatus,
} from "./machines-api";
import { GROUP_TITLE, SETTINGS_CARD } from "./settings-group";

export const MACHINES_KEY = ["machines.status"] as const;

/** How many machines can join, as the server keeps them. */
export const MAX_MACHINES = 16;

/** What runs `gram-host join` on the new machine, from a Gram checkout until it ships alone. */
export const JOIN_COMMAND = "node packages/server/src/host/main.ts join";
const STATUS_COMMAND = "node packages/server/src/host/main.ts status";

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
}: {
  machine: JoinedMachine;
  now: number;
  onConfirm: () => void;
  onRemove: () => void;
}) {
  const online = machine.confirmed && machine.onlineSince !== undefined;
  return (
    <div className="flex min-h-9 items-center gap-3" data-testid="machines-row">
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
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </span>
    </div>
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
  const [link, setLink] = useState<JoinLink | "tailscale-off" | "error">();
  const [known] = useState(() => new Set(machines.map((machine) => machine.id)));
  const [now, setNow] = useState(() => Date.now());
  const mint = () => {
    setLink(undefined);
    machinesApi.joinLink().then(setLink, () => setLink("error"));
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
      {link === "tailscale-off" ? (
        <>
          <Alert>
            <CircleAlert aria-hidden />
            <AlertDescription>
              Other machines reach this one at the address phone access serves on your tailnet. Turn
              on phone access first, then add the machine.
            </AlertDescription>
          </Alert>
          <div className="flex justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Close
            </Dialog.Close>
            <Button
              size="sm"
              render={<Link to="/settings/phones" />}
              nativeButton={false}
              onClick={onClose}
            >
              Phone access
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
              On the other machine, with Tailscale connected and Claude Code signed in, run this
              from a Gram checkout:
              <span className="mt-1.5 flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-sm bg-accent px-2 py-1 font-mono text-meta text-foreground select-all"
                  data-testid="machines-command"
                >
                  {JOIN_COMMAND}
                </code>
                <CopyButton text={JOIN_COMMAND} label="Copy" />
              </span>
            </li>
            <li>
              Paste this join link when it asks. It installs itself as a background service.
              <span className="mt-1.5 flex items-center gap-2">
                {link === undefined ? (
                  <span className="h-7 flex-1 animate-pulse rounded-sm bg-accent" />
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate font-mono text-meta text-foreground">
                      {link.url.replace(/#.*$/, "#code=…")}
                    </span>
                    <CopyButton text={link.url} label="Copy link" />
                  </>
                )}
              </span>
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
