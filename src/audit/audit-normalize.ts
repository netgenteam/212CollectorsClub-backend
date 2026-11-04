import { isIP } from 'node:net';

/**
 * Story 20.1 (AD-99), round-trip safety: the value that is HASHED must be exactly
 * the value Postgres STORES, otherwise the verifier recomputes a different hash
 * from the stored row and reports a false `HASH_MISMATCH` that nobody can ever
 * repair (the row is immutable).
 *
 * The rule, applied to every string that reaches the log (columns, `reason`,
 * `before`/`after` values AND keys): a character that Postgres cannot keep
 * becomes U+FFFD, in the application, before hashing and before the INSERT.
 *   - lone UTF-16 surrogates (`"\ud83d"`, e.g. an emoji cut by `slice()`): the
 *     driver turns them into U+FFFD on the wire for `text`, and `jsonb` rejects
 *     them (`\ud83d` escape) => a well-formedness pass;
 *   - U+0000: rejected by `text` and `jsonb` => U+FFFD (never an error: a NUL in
 *     a free-text reason must not fail a sale, and silently dropping it would
 *     hide that something was there).
 * Everything else a UTF-8 database stores verbatim.
 */
export const REPLACEMENT = '\ufffd';

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The string as Postgres will keep it. Idempotent (same as a well-formedness pass plus NUL). */
export function pgText(s: string): string {
  return s
    .replace(LONE_SURROGATE, REPLACEMENT)
    .replaceAll('\u0000', REPLACEMENT);
}

/** Length in characters as `varchar(n)` counts them (code points, not UTF-16 units). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    n += 1;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i += 1;
    }
  }
  return n;
}

/** The first `max` code points (never splits a surrogate pair). */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s; // fewer units than max => fewer code points
  let n = 0;
  let end = 0;
  for (const c of s) {
    if (n === max) break;
    n += 1;
    end += c.length;
  }
  return s.slice(0, end);
}

const ZONE_RE = /^[A-Za-z0-9._~-]{1,32}$/;

/**
 * Textual client address -> a string that is a valid `inet` for Postgres, or null.
 * `isIP` alone is not enough: it accepts `fe80::1%eth0` (a zone id), which
 * `::inet` rejects, and a failed cast aborts the whole audited transaction.
 * Accepts the shapes a proxy chain produces (`[::1]:443`, `1.2.3.4:5678`, a
 * zone id, which is dropped) and returns null for anything else. The database
 * still normalizes the text (`audit_normalize_ip`, never throws).
 */
export function cleanIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.length === 0 || s.length > 64) return null;
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracket) s = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(':'));
  }
  const pct = s.indexOf('%');
  if (pct >= 0) {
    if (!ZONE_RE.test(s.slice(pct + 1))) return null;
    s = s.slice(0, pct);
  }
  return isIP(s) !== 0 ? s : null;
}
