import { embeddingOn, type HostedDeviceDone, type HostedDeviceView } from "@gram/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";

import { HostedDeviceActivityList } from "./hosted-device-activity";
import { GROUP_TITLE, SETTINGS_CARD } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

type Bridge = NonNullable<NonNullable<Window["gram"]>["hostedDevice"]>;
type Server = HostedDeviceView["servers"][number];
type Workspace = Server["workspaces"][number];

const bridgeOf = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : window.gram?.hostedDevice;

const machine = () => (window.gram?.platform === "darwin" ? "this Mac" : "this computer");

const UNAVAILABLE: Record<NonNullable<HostedDeviceView["unavailable"]>, string> = {
  "no-keyring":
    "Lending isn't available: there is no system keyring to keep the sign-in in. You can still sign in for this session.",
  "no-lock-signal":
    "Lending isn't available: Gram can't tell when this computer is locked or idle here.",
  "settings-edited": "Lending is off: its settings were changed outside Gram.",
};

const POLICY: Record<Workspace["policy"], string> = {
  on: "Commands and reads allowed",
  read: "Reads only",
  off: "Lending not allowed",
};

/** The device's state, read again whenever the shell says it changed. */
const useHostedDevice = (bridge: Bridge | undefined) => {
  const [state, setState] = useState<HostedDeviceView | null>();
  const read = useCallback(() => {
    if (bridge === undefined) return;
    void bridge.state().then(setState, () => setState(null));
  }, [bridge]);
  useEffect(() => {
    if (bridge === undefined) return undefined;
    read();
    return bridge.onChange(read);
  }, [bridge, read]);
  return { state, read };
};

/**
 * Settings → Machines → Hosted servers: signing in to a Gram server that runs work for an
 * organisation, what each sign-in allows, and lending this computer to its workspaces. Signing in
 * is the desktop app's, which keeps the sign-in; it needs hosted features on, and says so with a
 * way to turn them on rather than leaving it to Diagnostics. Lend, Resume and Lift the pause only
 * open a decision the app draws; Stop and Sign out act at once, since they only take authority away.
 */
export function HostedServersPage() {
  const bridge = bridgeOf();
  const settings = useServerSettings((s) => s.settings);
  const hosted = settings !== undefined && embeddingOn(settings);
  const save = useSaveSettings();
  const { state, read } = useHostedDevice(hosted ? bridge : undefined);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string>();

  if (bridge === undefined)
    return (
      <p className="text-meta text-muted-foreground" data-testid="hosted-servers-elsewhere">
        Signing in to a hosted server is in the Gram desktop app, which keeps the sign-in.
      </p>
    );

  if (!hosted)
    return (
      <section className={SETTINGS_CARD} data-testid="hosted-servers-off">
        <p>Hosted features are off.</p>
        <p className="text-meta text-muted-foreground">
          Turn them on to sign in to a server, send it work from New task or your orchestrator, and
          lend it {machine()} where its admins allow.
        </p>
        <div>
          <Button
            size="sm"
            disabled={settings === undefined || busy}
            onClick={() => {
              setBusy(true);
              setWhy(undefined);
              save({ experimental: { embedding: true } })
                .catch((e: unknown) => setWhy(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Turn on hosted features
          </Button>
        </div>
        {why !== undefined && (
          <p role="alert" className="text-meta text-destructive">
            {why}
          </p>
        )}
      </section>
    );

  const act = async (run: () => Promise<HostedDeviceDone | void>) => {
    setBusy(true);
    setWhy(undefined);
    try {
      const done = await run();
      if (done !== undefined && !done.ok && done.why !== "Cancelled.") setWhy(done.why);
    } catch (error) {
      setWhy(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      read();
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="hosted-device">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const server = typed.trim();
          if (server === "") return;
          void act(async () => {
            const done = await bridge.signIn(server);
            if (done.ok) setTyped("");
            return done;
          });
        }}
      >
        <Input
          aria-label="Server address"
          placeholder="https://gram.example.com"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="max-w-80"
        />
        <Button type="submit" size="sm" disabled={busy || typed.trim() === ""}>
          Sign in
        </Button>
      </form>
      {why !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {why}
        </p>
      )}
      {state === undefined ? (
        <p className="text-meta text-muted-foreground">Checking…</p>
      ) : state === null ? (
        <p className="text-meta text-muted-foreground">Starting…</p>
      ) : (
        <>
          {state.unavailable !== undefined && (
            <p
              role="status"
              className="px-1 text-meta text-muted-foreground"
              data-testid="hosted-unavailable"
            >
              {UNAVAILABLE[state.unavailable]}
              {state.unavailable === "settings-edited" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-2"
                  disabled={busy}
                  onClick={() => void act(() => bridge.startAfresh())}
                >
                  Start afresh…
                </Button>
              )}
            </p>
          )}
          {state.servers.length === 0 && (
            <p className="text-meta text-muted-foreground">
              Not signed in to a server yet. Type the address your organisation gave you.
            </p>
          )}
          {state.servers.map((server) => (
            <ServerCard key={server.origin} server={server} bridge={bridge} busy={busy} act={act} />
          ))}
          {state.servers.length > 0 && (
            <section
              className="flex flex-col gap-2"
              aria-labelledby="hosted-lending-title"
              data-testid="hosted-lending"
            >
              <div className="flex flex-col gap-0.5 px-1">
                <h3 id="hosted-lending-title" className={GROUP_TITLE}>
                  Lending {machine()}
                </h3>
                <p className="text-meta text-muted-foreground">
                  A hosted thread can ask to run a command or read a file in a folder you lend. Each
                  request asks you first, and only while you are at {machine()}. Lend each workspace
                  above.
                </p>
              </div>
              <HostedDeviceActivityList bridge={bridge} view={state} machine={machine()} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** What a sign-in lets this computer do with its server, in the order a person meets them. */
const allows = (server: Server): string | undefined => {
  const said = [
    server.runsWork === true ? "Runs work sent from here" : undefined,
    server.takesThreads === true ? "takes threads moved there" : undefined,
    server.workspaces.some((workspace) => workspace.policy !== "off")
      ? `may borrow ${machine()}`
      : undefined,
  ].filter((each) => each !== undefined);
  if (said.length === 0) return undefined;
  const line = said.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
};

function ServerCard({
  server,
  bridge,
  busy,
  act,
}: {
  server: Server;
  bridge: Bridge;
  busy: boolean;
  act: (run: () => Promise<HostedDeviceDone | void>) => Promise<void>;
}) {
  return (
    <div className={SETTINGS_CARD} data-testid="hosted-server">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{server.name}</span>
          <span className="truncate font-mono text-meta text-muted-foreground">
            {server.origin}
          </span>
          {server.signedIn && allows(server) !== undefined && (
            <span className="text-meta text-muted-foreground" data-testid="hosted-allows">
              {allows(server)}
            </span>
          )}
        </span>
        {server.paused && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => bridge.liftPause(server.origin))}
          >
            Lift the pause…
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act(() => bridge.refresh(server.origin))}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act(() => bridge.signOut(server.origin))}
        >
          Sign out
        </Button>
      </div>
      {(server.problem !== undefined || server.paused || !server.signedIn) && (
        <p className="text-meta text-muted-foreground">
          {server.paused
            ? "Paused after three requests in a row were refused or went unanswered."
            : (server.problem ?? "Signed out. Sign in again.")}
        </p>
      )}
      {server.workspaces.map((workspace) => (
        <WorkspaceRow
          key={workspace.id}
          origin={server.origin}
          workspace={workspace}
          bridge={bridge}
          busy={busy || !server.signedIn}
          act={act}
        />
      ))}
    </div>
  );
}

function WorkspaceRow({
  origin,
  workspace,
  bridge,
  busy,
  act,
}: {
  origin: string;
  workspace: Workspace;
  bridge: Bridge;
  busy: boolean;
  act: (run: () => Promise<HostedDeviceDone | void>) => Promise<void>;
}) {
  const state =
    workspace.lending === "on"
      ? workspace.connected
        ? "Lent · connected"
        : "Lent"
      : workspace.lending === "resume"
        ? "Lent before Gram quit"
        : POLICY[workspace.policy];
  return (
    <div className="flex flex-col gap-1" data-testid="hosted-workspace">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">
            {workspace.name}
            <span className="text-muted-foreground"> · {workspace.organisation}</span>
          </span>
          <span className="text-meta text-muted-foreground">
            {state}
            {workspace.lending !== "off" && workspace.readOnly ? " · reads only" : ""}
          </span>
        </span>
        {workspace.lending === "off" && workspace.policy !== "off" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => bridge.lend(origin, workspace.id))}
          >
            Lend {machine()}…
          </Button>
        )}
        {workspace.lending === "resume" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(() => bridge.resume(origin, workspace.id))}
          >
            Resume lending…
          </Button>
        )}
        {workspace.lending !== "off" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act(() => bridge.stop(origin, workspace.id))}
          >
            Stop lending
          </Button>
        )}
      </div>
      {workspace.folders.length > 0 && (
        <ul className="flex flex-col font-mono text-meta text-muted-foreground">
          {workspace.folders.map((folder) => (
            <li key={folder.id} className="truncate">
              {folder.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
