/**
 * A copy of `value` without the keys whose value is undefined, so spreading
 * it over defaults cannot replace a default with undefined.
 */
export function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
