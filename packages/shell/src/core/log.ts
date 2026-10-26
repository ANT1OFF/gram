/**
 * The logger a shell module writes to: the shell's own pino logger in each app, given as these
 * three levels so the core never imports it. Fields are structured and never carry a secret.
 */
export interface ShellLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}
