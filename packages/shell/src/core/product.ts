/**
 * What differs between the apps that use this package, by name rather than by code: what a tray,
 * a dialog or a notification calls the app. Each app passes its own; the desktop's is
 * `{ name: "Gram" }`.
 */
export interface ShellProduct {
  readonly name: string;
}
