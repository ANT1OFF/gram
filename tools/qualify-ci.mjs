import { qualifiedCiResults } from "../packages/git/src/ci-policy.ts";

if (
  !qualifiedCiResults(process.env.CI_KIND ?? "", {
    classify: process.env.CI_CLASSIFY_RESULT,
    docs: process.env.CI_DOCS_RESULT,
    check: process.env.CI_CHECK_RESULT,
    e2e: process.env.CI_E2E_RESULT,
    macos: process.env.CI_MACOS_RESULT,
  })
)
  throw new Error("CI classification or required qualification jobs did not succeed");
