/**
 * Story 20.5 (QA round 3): REDACT BEFORE CUTTING.
 *
 * A long text is cut so the work stays bounded (a log line, an audit payload string, a key, a
 * `reason`). Cutting FIRST and redacting the cut text leaves a PREFIX of whatever token straddled
 * the cut in the clear: `V-123456` of a cedula whose last two digits were cut, `maria@gmail` of an
 * email, and in an immutable log nothing can be removed later.
 *
 * `redactedPrefix` redacts a window that is `margin` characters LONGER than the cut, redacts the cut
 * text on its own as well, and keeps only what both agree on: a token that straddles the cut is
 * recognised in the longer window (replaced by its marker there) and not in the short one (still
 * plain text there), so the output stops right before it. The work is two passes over at most
 * `max + margin` characters, never over the whole input.
 *
 * `margin` must be at least as long as the longest token a detector can recognise only when it
 * sees all of it (a cedula is at most ~16 characters, an email 254, a stored ciphertext ~450).
 */
export const CUT_MARGIN = 512;

/** The longest common prefix of `a` and `b`; never ends in the middle of a surrogate pair. */
export function commonPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  if (i > 0) {
    const last = a.charCodeAt(i - 1);
    if (last >= 0xd800 && last <= 0xdbff) i -= 1;
  }
  return a.slice(0, i);
}

/**
 * The redacted text of the first `max` UTF-16 units of `input` (the whole redacted `input` when it
 * is not longer), with no prefix of a sensitive token left at the cut.
 */
export function redactedPrefix(
  input: string,
  max: number,
  redact: (s: string) => string,
  margin: number = CUT_MARGIN,
): string {
  if (input.length <= max) return redact(input);
  const wide = redact(input.slice(0, max + margin));
  const narrow = redact(input.slice(0, max));
  return commonPrefix(wide, narrow);
}
