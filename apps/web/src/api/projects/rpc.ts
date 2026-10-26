import { run, type RpcContext } from "../rpc-client";
import type { ProjectsApi } from "./types";

/** `ProjectsApi` over the RPC client; a clone's `signal` interrupts it on the server. */
export const projectsRpc = ({ client }: RpcContext): ProjectsApi => ({
  listProjects: () => run(client["projects.list"](undefined)),
  listRepositories: () => run(client["projects.repositories"](undefined)),
  addProject: (root) => run(client["projects.add"]({ root })),
  cloneProject: (remote, options) =>
    run(
      client["projects.clone"](
        options?.into === undefined ? { remote } : { remote, into: options.into },
      ),
      options?.signal,
    ),
  cloneSuggestions: () => run(client["projects.cloneSuggestions"](undefined)),
  setProjectBookmarked: (projectId, bookmarked) =>
    run(client["projects.setBookmarked"]({ projectId, bookmarked })),
  forgetProject: (projectId) => run(client["projects.forget"]({ projectId })),
});
