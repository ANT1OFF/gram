import type { UsageProvider } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface UsageHistoryRoot {
  readonly provider: UsageProvider;
  readonly dir: string;
  readonly unresolved?: boolean;
}
/** Server-owned roots only. No RPC caller can provide a path or credential. */
export class UsageHistoryRoots extends Context.Service<
  UsageHistoryRoots,
  {
    readonly roots: Effect.Effect<readonly UsageHistoryRoot[]>;
  }
>()("@gram/server/UsageHistoryRoots") {}

export function usageHistoryRoots(
  home: string,
  dataDir: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly UsageHistoryRoot[] {
  const configured = (value: string | undefined) => {
    const expanded = value?.startsWith("~/") ? join(home, value.slice(2)) : value;
    return expanded && isAbsolute(expanded) ? expanded : undefined;
  };
  const codex = configured(env["CODEX_HOME"]),
    claude = configured(env["CLAUDE_CONFIG_DIR"]);
  return [
    ...new Set([
      join(home, ".codex"),
      ...(codex === undefined ? [] : [codex]),
      join(dataDir, "codex-home"),
      join(dataDir, "codex-owned-home"),
    ]),
  ]
    .flatMap((dir): UsageHistoryRoot[] =>
      ["sessions", "archived_sessions"].map((lane) => ({
        provider: "codex",
        dir: join(dir, lane),
      })),
    )
    .concat(
      [...new Set([join(home, ".claude"), ...(claude === undefined ? [] : [claude])])].map(
        (dir) => ({ provider: "claude", dir: join(dir, "projects") }),
      ),
    )
    .concat([
      ...(env["CODEX_HOME"] && codex === undefined
        ? [{ provider: "codex" as const, dir: "", unresolved: true }]
        : []),
      ...(env["CLAUDE_CONFIG_DIR"] && claude === undefined
        ? [{ provider: "claude" as const, dir: "", unresolved: true }]
        : []),
    ]);
}

export const usageHistoryRootsLayer = (
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = homedir(),
) =>
  Layer.succeed(UsageHistoryRoots, {
    roots: Effect.sync(() => usageHistoryRoots(home, dataDir, env)),
  });
