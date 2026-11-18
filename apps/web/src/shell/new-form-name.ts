/** Whether `pathname` is one of the New form's pages. */
export const isNewForm = (pathname: string): boolean =>
  pathname === "/new" || pathname === "/new-task" || pathname === "/new-workspace";

/**
 * The New form's page by name, as the title bar's path and the phone header both say it: "New
 * workspace" in the app's own noun for one ("New project"), else "New task".
 */
export const newFormName = (pathname: string, noun: string): string =>
  pathname === "/new-workspace" ? `New ${noun.toLowerCase()}` : "New task";
