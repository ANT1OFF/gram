import { cn as appCn } from "@/lib/utils";

/** A class or a falsy value that is left out. */
export type ClassInput = string | false | null | undefined | readonly ClassInput[];

/**
 * Joins class names, leaving out the falsy ones, and settles Tailwind classes that conflict in
 * favour of the later one, as Gram's own components do.
 */
export const cn: (...classes: ClassInput[]) => string = (...classes) =>
  appCn(...(classes as Parameters<typeof appCn>));
