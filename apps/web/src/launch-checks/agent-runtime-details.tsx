import type { AgentRuntime, Installer } from "@gram/contracts";
import type { ReactNode } from "react";

import { bindingLabel, newerNote, shortDate, SOURCE_LABEL, stepLabel } from "./agent-runtime-model";
import { CopyCommandButton } from "./agent-runtime-row";
import { ManagedRuntimeControls } from "./managed-runtime";
import { CommandText } from "./command-text";

const INSTALLER_LABEL: Readonly<Record<Installer, string>> = {
  npm: "npm",
  pnpm: "pnpm",
  bun: "Bun",
  brew: "Homebrew",
  native: "Standalone / native",
  nix: "Nix / Home Manager",
  bundled: "App / daemon runtime",
  unknown: "Unknown",
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-break-word">{children}</dd>
    </>
  );
}

/**
 * An agent row's details: where its CLI is, what this build binds it to, the newest release and
 * its wait, and each command that gets a supported version, to copy. The row's Update runs the
 * first for the user where it can; either way the user's installer, and its own release-age
 * policy, stay in charge.
 */
export function AgentRuntimeDetails({
  runtime,
  releasesCheckedAt,
  releasesUnavailable,
  releasesChecking = false,
}: {
  runtime: AgentRuntime;
  releasesCheckedAt: number | undefined;
  releasesUnavailable?: string | undefined;
  releasesChecking?: boolean;
}) {
  const { resolved } = runtime;
  const note = newerNote(runtime);
  return (
    <div
      data-testid="runtime-details"
      className="ms-6 mt-1 mb-2 flex flex-col gap-2 border-s border-border/60 ps-3 text-xs"
    >
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5">
        <Fact label="Runs">
          {resolved === undefined ? (
            "not installed"
          ) : (
            <span className="font-mono break-all">
              {resolved.path}
              <span className="font-sans text-muted-foreground">{` · ${SOURCE_LABEL[resolved.source]}`}</span>
            </span>
          )}
        </Fact>
        {runtime.installation !== undefined && (
          <>
            <Fact label="Installed by">{INSTALLER_LABEL[runtime.installation.installer]}</Fact>
            {runtime.installation.realPath !== resolved?.path && (
              <Fact label="Real executable">
                <span className="font-mono break-all">{runtime.installation.realPath}</span>
              </Fact>
            )}
          </>
        )}
        {resolved?.shadowed?.map((other) => (
          <Fact key={other.path} label="Also on PATH">
            <span className="font-mono break-all text-muted-foreground">
              {`${other.path}${other.version === undefined ? "" : ` (${other.version})`}`}
            </span>
          </Fact>
        ))}
        <Fact label="Built for">{bindingLabel(runtime)}</Fact>
        <Fact label="Compatibility">
          {runtime.verdict === "supported" ? "supported" : (runtime.reason ?? runtime.verdict)}
        </Fact>
        {note !== undefined && <Fact label="Newer">{note.detail}</Fact>}
        {releasesChecking && releasesCheckedAt === undefined ? (
          <Fact label="Newer releases">checking through your npm…</Fact>
        ) : releasesUnavailable !== undefined ? (
          <Fact label="Newer releases">{`can't check: ${releasesUnavailable}`}</Fact>
        ) : (
          releasesCheckedAt !== undefined && (
            <Fact label="Releases checked">{`${shortDate(releasesCheckedAt)}, through your npm`}</Fact>
          )
        )}
      </dl>
      {runtime.installation?.updateNote !== undefined && (
        <p className="text-muted-foreground" data-testid="runtime-update-note">
          <CommandText text={runtime.installation.updateNote} />
        </p>
      )}
      {runtime.installSteps.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="runtime-steps">
          <span className="text-muted-foreground">
            {runtime.installSteps[0]?.run === undefined
              ? "Run one of these yourself in a terminal."
              : "Update runs the first of these for you, or run one yourself in a terminal."}
          </span>
          {runtime.installSteps.map((step) => (
            <div key={step.command} className="flex min-w-0 items-center gap-2">
              <span className="w-28 shrink-0 text-muted-foreground">{stepLabel(step)}</span>
              <code className="min-w-0 truncate rounded-sm bg-muted px-1 font-mono">
                {step.command}
              </code>
              <CopyCommandButton command={step.command} />
            </div>
          ))}
        </div>
      )}
      {runtime.managed !== undefined && <ManagedRuntimeControls runtime={runtime} />}
    </div>
  );
}
