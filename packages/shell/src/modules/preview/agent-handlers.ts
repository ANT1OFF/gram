import type { WebContents } from "electron";

import type {
  BrowserInspection,
  BrowserRegion,
  BrowserViewportPreset,
  PaneResult,
} from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import { parsePaneCommand } from "../../core/browse-rules.ts";
import type { ShellIpc } from "../ipc.ts";

/**
 * What the preview asks of the agent browser about a thread's page. Each question answers
 * `undefined` for a page no agent drives, or for a URL the preview's own rules decide: loopback,
 * and a link the user follows off it.
 */
/** One request of a preview's page, as `webRequest.onBeforeRequest` reports it. */
export interface PreviewRequestDetails {
  /** The same for each hop of one request's redirects. */
  readonly id: number;
  readonly url: string;
  readonly method: string;
  readonly mainFrame: boolean;
  /** A frame inside the page navigating, which a form can target as well as the page itself. */
  readonly subFrame: boolean;
  /** The origin of the page that started it; absent for a load the app itself started. */
  readonly initiator?: string | undefined;
}

export interface PreviewAgent {
  /** Whether a main-frame navigation of an agent's page loads, or is stopped. */
  navigation(contents: WebContents, url: string): "load" | "block" | undefined;
  /** Whether one request of an agent's page goes out, as the session's `webRequest` sees it. */
  request(
    contents: WebContents,
    details: PreviewRequestDetails,
  ): Promise<"allow" | "block"> | undefined;
  /** The user put input into `contents`. */
  userInput(contents: WebContents): void;
  /** Who drives the thread's page, once its agent has used it. */
  driverOf(threadId: string): "agent" | "user" | undefined;
  /** Whether `url` is one of Gram's own pages the server named for the thread (a file preview). */
  isAppPage?(threadId: string, url: string): boolean;
  actionOf?(threadId: string): { readonly summary: string; readonly at: number } | undefined;
  recordingOf?(threadId: string): boolean;
  handBack(threadId: string): void;
  takeOver(threadId: string): void;
  inspectionOf(threadId: string): BrowserInspection | undefined;
  inspect(threadId: string, target?: { ref?: string; region?: BrowserRegion }): Promise<PaneResult>;
  viewport(threadId: string, preset: BrowserViewportPreset): Promise<PaneResult>;
}

type PreviewLookup = (
  input: unknown,
  sender: WebContents,
) => { readonly threadId: string; readonly kind: "local" | "web" } | undefined;

/** Serves hand-back, take-over, inspection and viewport for every window. */
export function installAgentHandlers(
  ipc: ShellIpc,
  previewFor: PreviewLookup,
  agent: PreviewAgent | undefined,
): void {
  ipc.on(Channels.previewHandBack, (event, input) => {
    const threadId = previewFor(input, event.sender)?.threadId;
    if (threadId !== undefined) agent?.handBack(threadId);
  });
  ipc.on(Channels.previewTakeOver, (event, input) => {
    const threadId = previewFor(input, event.sender)?.threadId;
    if (threadId !== undefined) agent?.takeOver(threadId);
  });
  const unavailable: PaneResult = {
    ok: false,
    code: "noPane",
    message: "Browser inspection unavailable here.",
  };
  ipc.handle(Channels.previewInspect, (input, event) => {
    const preview = previewFor(input, event.sender);
    const target =
      typeof input === "object" && input !== null && "target" in input ? input.target : undefined;
    const command = parsePaneCommand({
      op: "screenshot",
      ...(typeof target === "object" && target !== null ? target : {}),
    });
    if (preview === undefined || preview.kind !== "local" || command?.op !== "screenshot")
      return unavailable;
    return (
      agent?.inspect(preview.threadId, {
        ...(command.ref === undefined ? {} : { ref: command.ref }),
        ...(command.region === undefined ? {} : { region: command.region }),
      }) ?? unavailable
    );
  });
  ipc.handle(Channels.previewViewport, (input, event) => {
    const preview = previewFor(input, event.sender);
    const preset =
      typeof input === "object" && input !== null && "preset" in input ? input.preset : undefined;
    const command = parsePaneCommand({ op: "viewport", preset });
    if (
      preview === undefined ||
      preview.kind !== "local" ||
      command?.op !== "viewport" ||
      command.preset === undefined
    )
      return unavailable;
    return agent?.viewport(preview.threadId, command.preset) ?? unavailable;
  });
}
