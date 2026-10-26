import { BRANCH_PREFIXES, type BranchPrefix } from "@/composer/branch-name";

/** The `agents.branchPrefix` setting as a known prefix; `feat` when unset or unrecognised. */
export const branchPrefixSetting = (value: string | undefined): BranchPrefix =>
  BRANCH_PREFIXES.find((prefix) => prefix === value) ?? "feat";
