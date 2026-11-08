import {
  MAX_REMOTE_DEVICES,
  type RemoteAccessStatus,
  type RemoteDevice,
  type TailscaleState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Copy,
  Laptop,
  Plus,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Tablet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { encode } from "uqr";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { agoText, formatDay, formatStamp } from "@/lib/time";
import { Dialog, DialogShell } from "@/thread/dialog-shell";

import { copyText } from "./copy-text";
import { inputCls, SettingRow } from "./fields";
import { phoneAccess, PhoneAccessError } from "./phone-access-api";
import { GROUP_TITLE, SETTINGS_CARD } from "./settings-group";

export const PHONE_ACCESS_KEY = ["remote.status"] as const;

const message = (error: unknown) =>
  error instanceof PhoneAccessError ? error.message : "Couldn't reach Gram's server";

/** How a paired browser reads in its row: when it paired, and when it was last seen. */
export function deviceSeen(device: RemoteDevice, now = Date.now()): string {
  const paired =
    device.pairedAt === undefined ? "Paired" : `Paired ${formatDay(device.pairedAt, now)}`;
  if (device.lastSeenAt === undefined) return `${paired} · not seen since`;
  // Last seen is kept to the hour, so anything inside it reads as this hour.
  const seen =
    now - device.lastSeenAt < 60 * 60_000
      ? "this hour"
      : now - device.lastSeenAt < 30 * 86_400_000
        ? agoText(device.lastSeenAt, now, { long: true })
        : `on ${formatStamp(device.lastSeenAt, now)}`;
  return `${paired} · last seen ${seen}`;
}

const deviceIcon = (label: string) =>
  label.startsWith("iPhone") || label.startsWith("Android")
    ? Smartphone
    : label.startsWith("iPad")
      ? Tablet
      : Laptop;

/** Settings → Machines → Phones and browsers. */
export function PhoneAccessPage() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState(false);
  const [removing, setRemoving] = useState<RemoteDevice | "all">();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: PHONE_ACCESS_KEY,
    queryFn: phoneAccess.status,
    retry: false,
    // The pairing dialog watches for the phone; otherwise a slow refresh keeps "last seen" honest.
    refetchInterval: pairing ? 1500 : 30_000,
  });
  const act = async (run: () => Promise<RemoteAccessStatus>) => {
    setError(undefined);
    setBusy(true);
    try {
      queryClient.setQueryData(PHONE_ACCESS_KEY, await run());
    } catch (e) {
      setError(message(e));
      void queryClient.invalidateQueries({ queryKey: PHONE_ACCESS_KEY });
    } finally {
      setBusy(false);
    }
  };

  if (status.isPending) return <p className="text-meta text-muted-foreground">Checking…</p>;
  if (status.isError)
    return (
      <p role="alert" className="text-meta text-destructive">
        {message(status.error)}
      </p>
    );
  const data = status.data;
  const serving = data.origin !== undefined;
  return (
    <div className="flex flex-col gap-6" data-testid="phone-access">
      {data.mode === "off" && data.tailscale.state !== "ready" ? (
        <TailscaleChecklist
          state={data.tailscale}
          checking={status.isFetching}
          onCheck={() => void status.refetch()}
        />
      ) : (
        <AccessCard
          status={data}
          busy={busy}
          onEnable={(port) => void act(() => phoneAccess.enable(port))}
          onDisable={() => void act(phoneAccess.disable)}
        />
      )}
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive" data-testid="phone-access-error">
          {error}
        </p>
      )}
      {(serving || data.devices.length > 0) && (
        <PairedList
          status={data}
          now={status.dataUpdatedAt}
          onPair={() => setPairing(true)}
          onRemove={setRemoving}
        />
      )}
      {pairing && (
        <PairDialog
          status={data}
          onClose={() => {
            setPairing(false);
            void queryClient.invalidateQueries({ queryKey: PHONE_ACCESS_KEY });
          }}
        />
      )}
      {removing !== undefined && (
        <RemoveDialog
          target={removing}
          onCancel={() => setRemoving(undefined)}
          onConfirm={async () => {
            await act(() =>
              phoneAccess.revoke(removing === "all" ? { all: true } : { id: removing.id }),
            );
            setRemoving(undefined);
          }}
        />
      )}
    </div>
  );
}

function AccessCard({
  status,
  busy,
  onEnable,
  onDisable,
}: {
  status: RemoteAccessStatus;
  busy: boolean;
  onEnable: (port: number | undefined) => void;
  onDisable: () => void;
}) {
  const [port, setPort] = useState(String(status.port));
  const dnsName = "dnsName" in status.tailscale ? status.tailscale.dnsName : undefined;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;
  const address =
    status.origin ??
    (dnsName === undefined
      ? undefined
      : `https://${dnsName}${portValid && portNumber !== 443 ? `:${portNumber}` : ""}`);

  if (status.mode === "env")
    return (
      <div className={SETTINGS_CARD}>
        <SettingRow
          label="Phone access"
          description="On, set by GRAM_REMOTE_ORIGIN when Gram started. Unset it and restart to manage it here."
          disabledReason="GRAM_REMOTE_ORIGIN sets this"
        >
          <Switch checked disabled aria-label="Phone access" />
        </SettingRow>
        <AddressRow
          address={status.origin}
          note="Your own Serve listener; Gram doesn't change it."
        />
      </div>
    );

  if (status.mode === "on")
    return (
      <div className="flex flex-col gap-3">
        {status.problem !== undefined && (
          <Alert data-testid="phone-access-problem">
            <CircleAlert aria-hidden />
            <AlertTitle>Phone access is on, but phones can&apos;t reach Gram</AlertTitle>
            <AlertDescription>{status.problem}</AlertDescription>
          </Alert>
        )}
        <div className={SETTINGS_CARD}>
          <SettingRow
            label="Phone access"
            description="On through Tailscale Serve. Only your tailnet can reach it."
          >
            <Switch
              checked
              disabled={busy}
              aria-label="Phone access"
              onCheckedChange={(next) => {
                if (!next) onDisable();
              }}
            />
          </SettingRow>
          {status.origin !== undefined && <AddressRow address={status.origin} />}
        </div>
      </div>
    );

  return (
    <div className={SETTINGS_CARD}>
      <SettingRow
        label="Phone access"
        description={`Off. Turning it on serves Gram at ${address ?? "your tailnet name"} to your tailnet only. Gram adds its own Serve listener and leaves any others alone.`}
      >
        <Button
          disabled={busy || !portValid}
          onClick={() => onEnable(portValid ? portNumber : undefined)}
        >
          Turn on
        </Button>
      </SettingRow>
      <SettingRow
        label="Port"
        description="A free HTTPS port on this computer's tailnet name."
        htmlFor="phone-access-port"
        {...(portValid ? {} : { error: "A port from 1 to 65535" })}
      >
        <input
          id="phone-access-port"
          inputMode="numeric"
          className={`${inputCls} w-24 tabular-nums`}
          value={port}
          onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
        />
      </SettingRow>
    </div>
  );
}

function AddressRow({ address, note }: { address: string | undefined; note?: string }) {
  const [copied, setCopied] = useState(false);
  if (address === undefined) return null;
  return (
    <SettingRow label="Address" {...(note === undefined ? {} : { description: note })}>
      <span className="font-mono text-meta select-all" data-testid="phone-access-address">
        {address}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void copyText(address).then(() => setCopied(true));
        }}
      >
        <Copy aria-hidden />
        {copied ? "Copied" : "Copy"}
      </Button>
    </SettingRow>
  );
}

/** Why phone access can't turn on yet, as the three things it needs, in order. */
function TailscaleChecklist({
  state,
  checking,
  onCheck,
}: {
  state: TailscaleState;
  checking: boolean;
  onCheck: () => void;
}) {
  const installed = state.state !== "missing";
  const signedIn = installed && state.state !== "signed-out" && state.state !== "stopped";
  const https = signedIn && state.state !== "no-https" && state.state !== "error";
  const steps: ReadonlyArray<{ label: string; done: boolean; reached: boolean; detail: string }> = [
    {
      label: "Tailscale installed",
      done: installed,
      reached: true,
      detail: installed ? "Found." : "Not found. Get it from tailscale.com.",
    },
    {
      label: "Signed in to a tailnet",
      done: signedIn,
      reached: installed,
      detail: !installed
        ? "Checked once Tailscale is installed."
        : signedIn
          ? "Connected."
          : state.state === "stopped"
            ? "Tailscale isn't connected. Connect it from its menu."
            : "Sign in from Tailscale's menu.",
    },
    {
      label: "HTTPS certificates on for the tailnet",
      done: https,
      reached: signedIn,
      detail: !signedIn
        ? "Checked once Tailscale is signed in."
        : state.state === "error"
          ? "Tailscale didn't answer. Check again in a moment."
          : "Turned on in the Tailscale admin console, under DNS.",
    },
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="phone-access-tailscale">
      <Alert className="has-data-[slot=alert-action]:pr-32">
        <CircleAlert aria-hidden />
        <AlertTitle>Tailscale isn&apos;t ready on this computer</AlertTitle>
        <AlertDescription>
          Phone access goes through Tailscale, so only your own devices can reach Gram.
        </AlertDescription>
        <div data-slot="alert-action" className="absolute top-2 right-2.5">
          <Button size="sm" variant="outline" disabled={checking} onClick={onCheck}>
            <RefreshCw aria-hidden />
            Check again
          </Button>
        </div>
      </Alert>
      <div className={SETTINGS_CARD}>
        {steps.map((step) => {
          const Icon = step.done ? CircleCheck : step.reached ? CircleX : CircleDashed;
          return (
            <div key={step.label} className="flex items-start gap-3">
              <Icon
                aria-hidden
                className={`mt-0.5 size-icon-row shrink-0 ${step.done ? "text-success" : step.reached ? "text-destructive" : "text-muted-foreground"}`}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{step.label}</span>
                <span className="text-meta text-muted-foreground">{step.detail}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PairedList({
  status,
  now,
  onPair,
  onRemove,
}: {
  status: RemoteAccessStatus;
  /** When the status was read, which "last seen" counts from. */
  now: number;
  onPair: () => void;
  onRemove: (target: RemoteDevice | "all") => void;
}) {
  const serving = status.origin !== undefined;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="phone-access-paired">
      <div className="flex items-center gap-2 px-1">
        <h3 id="phone-access-paired" className={GROUP_TITLE}>
          Paired
        </h3>
        <span className="text-meta text-muted-foreground tabular-nums">
          {status.devices.length} of {MAX_REMOTE_DEVICES}
        </span>
        {serving && (
          <Button size="sm" className="ms-auto" onClick={onPair} data-testid="phone-access-pair">
            <Plus aria-hidden />
            Pair a phone
          </Button>
        )}
      </div>
      {status.devices.length === 0 ? (
        <p className="px-1 text-meta text-muted-foreground">
          No phones yet. Pair one to use Gram from its browser.
        </p>
      ) : (
        <div className={SETTINGS_CARD} data-testid="phone-access-devices">
          {status.devices.map((device) => {
            const Icon = deviceIcon(device.label);
            return (
              <div key={device.id} className="flex min-h-9 items-center gap-3">
                <Icon aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    {device.label}
                    {device.id === status.current && (
                      <span className="text-meta text-muted-foreground">This browser</span>
                    )}
                  </span>
                  <span className="text-meta text-muted-foreground">{deviceSeen(device, now)}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto"
                  onClick={() => onRemove(device)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {status.devices.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-1">
          <span className="text-meta text-muted-foreground">
            {serving
              ? "Removing a browser signs it out at once and closes its open connections."
              : "Paired browsers stay paired while access is off, and can't connect until it is back on."}
          </span>
          {status.devices.length > 1 && (
            <Button size="sm" variant="ghost" onClick={() => onRemove("all")}>
              Remove all
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** The link as a QR code: dark modules on a light ground with its quiet zone, in either theme. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const quiet = 4;
  const full = size + quiet * 2;
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${full} ${full}`}
      shapeRendering="crispEdges"
      className="size-56 rounded-md"
      data-testid="phone-access-qr"
    >
      {/* Not palette colours: a camera reads dark modules on a light ground, whatever the theme. */}
      <rect width={full} height={full} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}

type Link = { readonly url: string; readonly expiresAt: number };

function PairDialog({ status, onClose }: { status: RemoteAccessStatus; onClose: () => void }) {
  const [link, setLink] = useState<Link | "full" | "error">();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const mint = () => {
    setLink(undefined);
    setCopied(false);
    phoneAccess.pair().then(setLink, () => setLink("error"));
  };
  useEffect(() => {
    // A newer link replaces an older one on the server, so only the last answer counts.
    let live = true;
    phoneAccess.pair().then(
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
  const pairing = status.pairing;
  const paired =
    pairing?.state === "paired" && typeof link === "object"
      ? status.devices.find((device) => device.id === pairing.device)
      : undefined;
  const expired =
    typeof link === "object" && (now >= link.expiresAt || pairing?.state === "expired");
  const left = typeof link === "object" ? Math.max(0, link.expiresAt - now) : 0;
  const countdown = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;

  return (
    <DialogShell testId="phone-access-pair-dialog" title="Pair a phone" onClose={onClose}>
      {link === "full" ? (
        <>
          <Alert>
            <CircleAlert aria-hidden />
            <AlertDescription>
              Eight browsers are paired, the most Gram keeps. Remove one to pair another.
            </AlertDescription>
          </Alert>
          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : link === "error" ? (
        <>
          <p role="alert" className="text-meta text-destructive">
            Couldn&apos;t make a pairing link.
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
      ) : paired !== undefined ? (
        <>
          <p className="flex items-center gap-2 font-medium" data-testid="phone-access-paired">
            <CircleCheck aria-hidden className="size-icon-row text-success" />
            {paired.label} is paired
          </p>
          <p className="text-muted-foreground">
            It&apos;s on the list now. Remove it there to sign it out.
          </p>
          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              Done
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
          <p className="text-muted-foreground">
            Scan this with the phone&apos;s camera. Tailscale has to be connected on the phone.
          </p>
          <div className="flex justify-center">
            {link === undefined ? (
              <div className="size-56 animate-pulse rounded-md bg-accent" />
            ) : (
              <QrCode text={link.url} label="QR code of the one-time pairing link" />
            )}
          </div>
          {link !== undefined && (
            <p className="text-center text-meta text-muted-foreground" aria-live="polite">
              Waiting for the phone · expires in <span className="tabular-nums">{countdown}</span>
            </p>
          )}
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertDescription className="text-meta">
              Until it is used, this link lets any browser that opens it control Gram. Send it only
              to your own phone, never to a shared chat.
            </AlertDescription>
          </Alert>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={link === undefined}
              onClick={() => {
                if (typeof link === "object") void copyText(link.url).then(() => setCopied(true));
              }}
            >
              <Copy aria-hidden />
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
              Cancel
            </Dialog.Close>
          </div>
        </>
      )}
    </DialogShell>
  );
}

function RemoveDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: RemoteDevice | "all";
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <DialogShell
      testId="phone-access-remove"
      title={target === "all" ? "Remove every paired browser?" : `Remove ${target.label}?`}
      onClose={onCancel}
    >
      <p className="text-muted-foreground">
        {target === "all"
          ? "They're all signed out at once, and any Gram tab open on them disconnects. Pair them again to use them."
          : "It's signed out at once, and any Gram tab open on it disconnects. Pair it again to use it."}
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
          {target === "all" ? "Remove all" : "Remove"}
        </Button>
      </div>
    </DialogShell>
  );
}

/** The Phones and browsers row under Machines: how many are paired, or Off. */
export function PhoneAccessSummary() {
  const { data } = useQuery({
    queryKey: PHONE_ACCESS_KEY,
    queryFn: phoneAccess.status,
    retry: false,
  });
  if (data === undefined) return null;
  if (data.mode === "off") return "Off";
  return data.devices.length === 0 ? "On" : `${data.devices.length} paired`;
}
