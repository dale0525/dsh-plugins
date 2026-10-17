/**
 * Class-name joiner.
 *
 * Conditional classes are written as `cx('a', on && 'b')` rather than pulling in
 * a dependency for eight lines.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
