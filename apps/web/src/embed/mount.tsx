import { embeddingOn, type ThreadId } from "@gram/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRoute,
  Link,
  RouterProvider,
  useNavigate,
  useParams,
  useRouterState,
  type AnyRoute,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ApiProvider, createApi } from "@/api/context";
import { setServerBase } from "@/api/server-base";
import type { Api } from "@/api/types";
import { installKeyboard } from "@/keyboard/registry";
import { setAppBasePath, appBasePath } from "@/lib/app-path";
import { createAppRouter } from "@/router";
import { ThreadView } from "@/thread/thread-view";
import { routeTree } from "@/routeTree.gen";

import type {
  GramHandle,
  MountGram,
  ShellContributions,
  ShellLinkComponent,
  ShellThreadComponent,
  ShellRoute,
  UseShellLocation,
} from "./contract";
import { EMPTY_SHELL, routeProblem, shellFor, useEmbedShell } from "./store";
import { bootTheme } from "./theme-boot";

/** An added page, in the conversation's place: it scrolls on its own, as Usage does. */
function ShellPage({ route }: { route: ShellRoute }) {
  const params = useParams({ strict: false }) as Readonly<Record<string, string>>;
  const Page = route.component;
  return (
    <section
      data-testid="embed-page"
      data-path={route.path}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <Page params={params} />
    </section>
  );
}

const addedRoutes = (routes: readonly ShellRoute[]): AnyRoute[] => {
  const taken = new Set<string>();
  return routes.map((route) => {
    const problem = routeProblem(route.path, taken);
    if (problem !== undefined) throw new Error(`gram: ${problem}`);
    taken.add(route.path);
    return createRoute({
      getParentRoute: () => routeTree,
      path: route.path,
      component: () => <ShellPage route={route} />,
    }) as unknown as AnyRoute;
  });
};

/** Turns the hosted features on in the in-memory server, which has nobody else to do it. */
const withHostedMock = async (api: Api): Promise<void> => {
  await api.updateSettings({ experimental: { embedding: true } });
};

let mounted = false;

/**
 * Mounts the whole app in `options.element`, against the server the options name. What `shell`
 * adds (pages, navigation groups, a switcher) is taken only from a server whose hosted features
 * are on: anywhere else the app is exactly as it is on its own.
 */
export const mountGram: MountGram = async (options) => {
  // The stores, the keyboard and the theme on `<html>` are the page's, not the element's.
  if (mounted) throw new Error("gram: the app is already mounted on this page");
  mounted = true;
  try {
    const mock = options.server === "mock";
    setServerBase(mock ? undefined : (options.server as { base?: string } | undefined)?.base);
    setAppBasePath(options.basePath);
    bootTheme(document.documentElement, window.localStorage);

    const api = await createApi(
      mock ? "mock" : "rpc",
      typeof options.server === "object" ? options.server.session : undefined,
    );
    if (mock) {
      await withHostedMock(api);
      // Before the router is built, so a page that opens on one of them finds it.
      for (const thread of options.mockThreads ?? []) window.gramMock?.simulateThread(thread);
    }
    // One answer, before the router is built: a page added to a server that has the features off
    // would otherwise exist and lead nowhere.
    const settings = await api.getSettings();
    const hosted = embeddingOn(settings);
    const shell: ShellContributions = shellFor(settings, options.shell);

    const queryClient = new QueryClient();
    const router = createAppRouter(queryClient, {
      basepath: appBasePath(),
      extra: addedRoutes(shell.routes ?? []),
    });
    useEmbedShell.setState({
      navigation: shell.navigation ?? [],
      workspaceSwitcher: shell.workspaceSwitcher,
      threads: shell.threads ?? "shown",
      panel: shell.panel ?? "shown",
      hosted,
      attention: shell.attention,
      threadsPage: shell.threadsPage ?? {},
      machines: shell.machines ?? {},
      models: shell.models ?? {},
      newEntry: shell.newEntry,
      toolCards: shell.toolCards ?? [],
      home: shell.home?.component,
      sidebar: shell.sidebar ?? {},
      document: shell.document ?? {},
      titles: Object.fromEntries([
        ...(shell.routes ?? []).flatMap((route) =>
          route.title === undefined ? [] : [[route.path, route.title] as const],
        ),
        ...(shell.home?.title === undefined ? [] : [["/", shell.home.title] as const]),
      ]),
    });
    const stopKeyboard = installKeyboard();

    const root = createRoot(options.element);
    root.render(
      <StrictMode>
        <ApiProvider api={api}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ApiProvider>
      </StrictMode>,
    );

    const handle: GramHandle = {
      shell: hosted ? "on" : "off",
      update: (next) => {
        if (!hosted) return;
        // Only what `next` names: a host that updates its counts keeps its switcher.
        useEmbedShell.setState({
          ...("navigation" in next ? { navigation: next.navigation ?? [] } : {}),
          ...("workspaceSwitcher" in next ? { workspaceSwitcher: next.workspaceSwitcher } : {}),
          ...("threads" in next ? { threads: next.threads ?? "shown" } : {}),
          ...("panel" in next ? { panel: next.panel ?? "shown" } : {}),
          ...("attention" in next ? { attention: next.attention } : {}),
          ...("threadsPage" in next ? { threadsPage: next.threadsPage ?? {} } : {}),
          ...("newEntry" in next ? { newEntry: next.newEntry } : {}),
          ...("sidebar" in next ? { sidebar: next.sidebar ?? {} } : {}),
          ...("document" in next ? { document: next.document ?? {} } : {}),
          ...("models" in next ? { models: next.models ?? {} } : {}),
        });
      },
      navigate: (to) => router.navigate({ to: to as "/" }),
      unmount: () => {
        stopKeyboard();
        root.unmount();
        useEmbedShell.setState(EMPTY_SHELL);
      },
    };
    return handle;
  } catch (error) {
    mounted = false;
    throw error;
  }
};

/** A link for the embedding app's pages and switcher: it moves the window, never reloads it. */
export const ShellLink: ShellLinkComponent = ({ to, className, children }) => (
  <Link {...({ to } as unknown as { to: "/" })} {...(className === undefined ? {} : { className })}>
    {children}
  </Link>
);

/** A thread for the embedding app's pages: beside what the page shows, as a worker's is in a dock. */
export const ShellThread: ShellThreadComponent = ({ threadId, placeholder }) => (
  <div className="flex h-full min-h-0 flex-col" data-testid="shell-thread">
    <ThreadView
      key={threadId}
      threadId={threadId as ThreadId}
      focused
      beside={{ header: null, ...(placeholder === undefined ? {} : { placeholder }) }}
    />
  </div>
);

/** Where the window is under the app, and a way to move it, for the embedding app's components. */
export const useShellLocation: UseShellLocation = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  return { pathname, navigate: (to) => navigate({ to: to as "/" }) };
};
