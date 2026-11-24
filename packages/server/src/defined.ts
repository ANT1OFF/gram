/** `A` without the fields it may set to `undefined`: those become optional and never `undefined`. */
export type Defined<A> = {
  [K in keyof A as undefined extends A[K] ? never : K]: A[K];
} & {
  [K in keyof A as undefined extends A[K] ? K : never]?: Exclude<A[K], undefined>;
};

/** `value` without the fields it sets to `undefined`, so it fits a type with exact optional fields. */
export const defined = <A extends object>(value: A): Defined<A> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dropping the undefined fields is exactly what Defined<A> names
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<A>;
