import { featureAvailable, type Diagnostics, type RuntimeFeatureId } from "@gram/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useApi } from "@/api/context";

/** `app.diagnostics`, fetched once per session and shared by the settings sections. */
export function useDiagnostics(): UseQueryResult<Diagnostics> {
  const api = useApi();
  return useQuery({
    queryKey: ["app.diagnostics"],
    queryFn: () => api.diagnostics(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Whether this window shows agents' pages from the server's own browser: there is no shell to draw
 * a page here (a browser tab), and the server runs a browser for its agents.
 */
export function useServerBrowser(): boolean {
  const shell = typeof window === "undefined" ? null : (window.gram ?? window.gramMock?.shell);
  const { data } = useDiagnostics();
  return shell?.preview === undefined && data?.serverBrowser === true;
}

/** Local feature policy plus bridge availability, including plain-browser restrictions. */
export function useFeature(id: RuntimeFeatureId, _options: { readonly settled?: boolean } = {}) {
  const where = {
    // The mock API stands in for the shell members its own slices serve.
    shell: typeof window === "undefined" ? null : (window.gram ?? window.gramMock?.shell ?? null),
  };
  return featureAvailable(id, where);
}
