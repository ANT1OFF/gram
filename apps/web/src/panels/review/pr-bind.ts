import type { ThreadId } from "@gram/contracts";

import type { Api } from "@/api/types";

import { parsePrRef } from "./pr-ref";

/**
 * Binds the PR the user typed: `12`, `#12`, `owner/repo#12` or a PR URL. A bare number needs the
 * thread's `origin`. With `extra` the thread follows it beside the PR it already has. Rejects with a
 * message the caller shows as is.
 */
export async function bindPrFromInput(
  api: Pick<Api, "prBind" | "prBindExtra">,
  threadId: ThreadId,
  input: string,
  origin: string | undefined,
  extra = false,
): Promise<void> {
  const ref = parsePrRef(input);
  if (!ref) throw new Error("Enter a PR number, owner/repo#N or a PR URL");
  const repo = ref.repo ?? origin;
  if (repo === undefined) throw new Error("Enter the full PR URL");
  if (extra) await api.prBindExtra(threadId, repo, ref.number);
  else await api.prBind(threadId, repo, ref.number);
}
