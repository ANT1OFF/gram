import type { ChildProcess } from "node:child_process";

export declare const E2E_TOKEN_PATH: string;
export declare const DEFAULT_E2E_PORT: number;
export declare const E2E_HOST: string;

export type ServerState = "ours" | "foreign" | "down";

export declare function checkServer(
  origin: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<ServerState>;

/** What `startE2eServer` needs from a spawned server process. */
export interface ServerChild {
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

export declare const E2E_DIST_DIR: string;

export declare function e2eServerMode(env?: NodeJS.ProcessEnv): "dev" | "preview";

export declare function spawnVite(
  port: number,
  token: string,
  env?: NodeJS.ProcessEnv,
  dir?: string,
  options?: { readonly isolatedDir?: string },
): ChildProcess;

export declare function buildForPreview(env?: NodeJS.ProcessEnv): Promise<void>;

export declare function spawnVitePreview(
  port: number,
  token: string,
  env?: NodeJS.ProcessEnv,
): ChildProcess;

export interface StartE2eServerOptions {
  readonly token: string;
  readonly pinnedPort?: number;
  readonly startPort?: number;
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly spawnServer?: (port: number, token: string) => ServerChild;
  readonly fetchImpl?: typeof fetch;
  readonly isFree?: (port: number) => Promise<boolean>;
}

export interface E2eServer {
  readonly port: number;
  readonly origin: string;
  stop(): Promise<void>;
}

export declare function startE2eServer(options: StartE2eServerOptions): Promise<E2eServer>;
