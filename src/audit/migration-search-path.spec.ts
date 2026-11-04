import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '..', '..', 'prisma', 'migrations');

/**
 * Story 20.1 (QA rounds 3 and 4). Every function/procedure a migration creates must carry
 * its own `search_path` AND that `search_path` must list `pg_temp` EXPLICITLY, LAST.
 *
 * Why not just "has a SET search_path"?
 *  - `pg_dump` starts every dump with an EMPTY search_path, so a function that names a
 *    table without a schema fails when a trigger fires during a `--data-only` restore.
 *  - `SET search_path FROM CURRENT` (round 3) fixed that but NOT the hijack: Postgres
 *    searches the session's temporary schema FIRST for relations and types unless
 *    `pg_temp` is listed, so a role with TEMPORARY on the database could shadow
 *    "Audit_Events" / "Legal_Documents" with a temporary table the trigger then read.
 *    `FROM CURRENT` does not list it, and neither does `SET search_path = public`.
 *  - `pg_catalog` must come FIRST for the same reason on built-in types, functions and
 *    operators (otherwise a schema earlier in the list could shadow them).
 *
 * What counts is the state after the LAST migration that touched the function:
 * `CREATE OR REPLACE FUNCTION` DROPS the setting, `ALTER FUNCTION ... RESET` / `RESET ALL`
 * removes it, and `ALTER FUNCTION ... SET search_path FROM CURRENT` (or a list without
 * `pg_temp` last) replaces it by something that no longer satisfies the rule. The scanner
 * tokenizes the SQL (comments, `'...'`, `"..."`, `$tag$...$tag$`) and looks at the whole
 * statement, so it does not depend on where the options sit relative to `AS '...'`.
 * It understands `public.f` / `"public"."f"`, `CREATE PROCEDURE`, `ALTER ROUTINE`,
 * `ALTER ... RENAME TO` and `DROP`. It cannot read a `DO` block that builds the statement
 * dynamically: use literal `ALTER FUNCTION` statements (a DO block with EXECUTE that
 * touches functions fails this suite on purpose).
 */

export interface Tok {
  t: 'word' | 'ident' | 'str' | 'dollar' | 'punct';
  v: string;
}

/** Splits migration SQL into statements of tokens; comments are dropped. */
export function tokenizeStatements(sql: string): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  let i = 0;
  const n = sql.length;
  const push = (tok: Tok) => cur.push(tok);
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      let j = i + 1;
      let v = '';
      for (; j < n; j++) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          v += "'";
          j++;
        } else if (sql[j] === "'") break;
        else v += sql[j];
      }
      push({ t: 'str', v });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      for (; j < n; j++) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          v += '"';
          j++;
        } else if (sql[j] === '"') break;
        else v += sql[j];
      }
      push({ t: 'ident', v });
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? n : end;
        push({ t: 'dollar', v: sql.slice(i + m[0].length, stop) });
        i = end === -1 ? n : end + m[0].length;
      } else {
        push({ t: 'punct', v: c });
        i++;
      }
    } else if (c === ';') {
      if (cur.length) out.push(cur);
      cur = [];
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      push({ t: 'word', v: sql.slice(i, j) });
      i = j;
    } else {
      push({ t: 'punct', v: c });
      i++;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

const isWord = (tok: Tok | undefined, ...ws: string[]) =>
  tok?.t === 'word' && ws.includes(tok.v.toLowerCase());

/** Reads `[schema .] name` from `i`; returns the bare (lower-cased if unquoted) name. */
function readName(
  toks: Tok[],
  i: number,
): { name: string; next: number } | null {
  const first = toks[i];
  if (!first || (first.t !== 'word' && first.t !== 'ident')) return null;
  let name = first.t === 'word' ? first.v.toLowerCase() : first.v;
  let next = i + 1;
  while (toks[next]?.t === 'punct' && toks[next].v === '.') {
    const part = toks[next + 1];
    if (!part || (part.t !== 'word' && part.t !== 'ident')) return null;
    name = part.t === 'word' ? part.v.toLowerCase() : part.v;
    next += 2;
  }
  return { name, next };
}

const ROUTINE = ['function', 'procedure', 'routine'];

/** What a statement does to a routine's search_path. */
type Effect =
  | { kind: 'set'; list: string[] | 'from-current' }
  | { kind: 'reset' }
  | { kind: 'none' };

/**
 * Looks for `SET search_path (TO|=) a, b, c` / `SET search_path FROM CURRENT` /
 * `RESET search_path` / `RESET ALL` among the option tokens (the body, a `str`/`dollar`
 * right after `AS`, is skipped). The LAST one wins.
 */
function searchPathEffect(toks: Tok[], from: number): Effect {
  let effect: Effect = { kind: 'none' };
  for (let i = from; i < toks.length; i++) {
    const tk = toks[i];
    if (
      isWord(tk, 'as') &&
      (toks[i + 1]?.t === 'str' || toks[i + 1]?.t === 'dollar')
    ) {
      i += toks[i + 2]?.t === 'punct' && toks[i + 2].v === ',' ? 3 : 1;
      continue;
    }
    if (isWord(tk, 'reset')) {
      if (isWord(toks[i + 1], 'all') || isWord(toks[i + 1], 'search_path')) {
        effect = { kind: 'reset' };
      }
      continue;
    }
    if (!isWord(tk, 'set') || !isWord(toks[i + 1], 'search_path')) continue;
    let j = i + 2;
    if (isWord(toks[j], 'from') && isWord(toks[j + 1], 'current')) {
      effect = { kind: 'set', list: 'from-current' };
      continue;
    }
    if (isWord(toks[j], 'to') || (toks[j]?.t === 'punct' && toks[j].v === '='))
      j++;
    const list: string[] = [];
    for (; j < toks.length; j++) {
      const it = toks[j];
      if (it.t === 'word' || it.t === 'ident' || it.t === 'str') {
        if (isWord(it, 'default')) {
          list.push('default');
        } else {
          // A quoted STRING is one schema name for Postgres ('a, b' is the schema "a, b").
          list.push(it.t === 'word' ? it.v.toLowerCase() : it.v);
        }
        if (toks[j + 1]?.t === 'punct' && toks[j + 1].v === ',') {
          j++;
          continue;
        }
      }
      break;
    }
    effect = { kind: 'set', list };
  }
  return effect;
}

/** `pg_catalog` first, `pg_temp` last, and the project schema between them. */
export function isHardenedSearchPath(list: string[] | 'from-current'): boolean {
  if (list === 'from-current') return false;
  return (
    list.length >= 3 &&
    list[0] === 'pg_catalog' &&
    list[list.length - 1] === 'pg_temp' &&
    list
      .slice(1, -1)
      .every((s) => s !== 'pg_temp' && s !== 'pg_catalog' && s !== 'default')
  );
}

export interface PinState {
  hardened: boolean;
  /** Where it stands, for the failure message. */
  detail: string;
}

/** Final state of every routine, keyed by bare name, after replaying the migrations in order. */
export function functionPinState(
  dir: string = MIGRATIONS,
): Map<string, PinState> {
  const state = new Map<string, PinState>();
  const dirs = readdirSync(dir)
    .filter((d) => /^\d{14}_/.test(d))
    .sort();
  for (const d of dirs) {
    const sql = readFileSync(join(dir, d, 'migration.sql'), 'utf8');
    applyStatements(state, tokenizeStatements(sql), d);
  }
  return state;
}

export function applyStatements(
  state: Map<string, PinState>,
  statements: Tok[][],
  origin: string,
): void {
  const describe = (e: Effect): PinState => {
    if (e.kind === 'set') {
      return {
        hardened: isHardenedSearchPath(e.list),
        detail: `${origin}: search_path = ${e.list === 'from-current' ? 'FROM CURRENT' : e.list.join(', ')}`,
      };
    }
    return {
      hardened: false,
      detail:
        e.kind === 'reset'
          ? `${origin}: RESET`
          : `${origin}: no SET search_path`,
    };
  };
  for (const toks of statements) {
    if (isWord(toks[0], 'do')) {
      // A DO block that builds ALTER/CREATE FUNCTION dynamically cannot be read here.
      if (
        toks.some(
          (t) =>
            t.t === 'dollar' && /\b(function|procedure|routine)\b/i.test(t.v),
        )
      ) {
        state.set(`<DO block in ${origin}>`, {
          hardened: false,
          detail:
            'a DO block touches functions: use literal ALTER FUNCTION statements so this test can read them',
        });
      }
    } else if (isWord(toks[0], 'create')) {
      let i = 1;
      if (isWord(toks[i], 'or') && isWord(toks[i + 1], 'replace')) i += 2;
      if (!isWord(toks[i], 'function', 'procedure')) continue;
      const nm = readName(toks, i + 1);
      if (!nm) continue;
      state.set(nm.name, describe(searchPathEffect(toks, nm.next)));
    } else if (isWord(toks[0], 'alter') && isWord(toks[1], ...ROUTINE)) {
      const nm = readName(toks, 2);
      if (!nm) continue;
      // skip the argument list "( ... )"
      let i = nm.next;
      if (toks[i]?.t === 'punct' && toks[i].v === '(') {
        let depth = 0;
        for (; i < toks.length; i++) {
          if (toks[i].t === 'punct' && toks[i].v === '(') depth++;
          if (toks[i].t === 'punct' && toks[i].v === ')' && --depth === 0) {
            i++;
            break;
          }
        }
      }
      if (isWord(toks[i], 'rename') && isWord(toks[i + 1], 'to')) {
        const to = readName(toks, i + 2);
        const prev = state.get(nm.name);
        if (to && prev) {
          state.delete(nm.name);
          state.set(to.name, prev);
        }
        continue;
      }
      const eff = searchPathEffect(toks, i);
      if (eff.kind !== 'none') state.set(nm.name, describe(eff));
    } else if (isWord(toks[0], 'drop') && isWord(toks[1], ...ROUTINE)) {
      let i = 2;
      if (isWord(toks[i], 'if') && isWord(toks[i + 1], 'exists')) i += 2;
      for (;;) {
        const nm = readName(toks, i);
        if (!nm) break;
        state.delete(nm.name);
        i = nm.next;
        // skip "( ... )" and an optional comma to the next routine
        if (toks[i]?.t === 'punct' && toks[i].v === '(') {
          let depth = 0;
          for (; i < toks.length; i++) {
            if (toks[i].t === 'punct' && toks[i].v === '(') depth++;
            if (toks[i].t === 'punct' && toks[i].v === ')' && --depth === 0) {
              i++;
              break;
            }
          }
        }
        if (toks[i]?.t === 'punct' && toks[i].v === ',') i++;
        else break;
      }
    }
  }
}

const statesOf = (sql: string): Map<string, PinState> => {
  const s = new Map<string, PinState>();
  applyStatements(s, tokenizeStatements(sql), 'sample');
  return s;
};

describe('every function created by a migration pins search_path = pg_catalog, <schema>, pg_temp (restorable, not hijackable)', () => {
  it('finds the known functions (the scanner works on the real migrations)', () => {
    const s = functionPinState();
    for (const f of [
      'audit_events_chain_guard',
      'audit_events_immutable',
      'audit_normalize_ip',
      'legal_guard_rows',
      'legal_guard_version_insert',
      'consent_guard_insert',
      'legal_floor_never_decreases',
    ]) {
      expect(s.has(f), f).toBe(true);
    }
  });

  it('none is left without pg_temp last after the last migration', () => {
    const bad = [...functionPinState()]
      .filter(([, st]) => !st.hardened)
      .map(([name, st]) => `${name} (${st.detail})`);
    expect(bad).toEqual([]);
  });

  describe('the scanner itself (synthetic migrations)', () => {
    const GOOD = 'SET search_path = pg_catalog, public, pg_temp';

    it('accepts the good form in any position, with $$, $tag$ and single-quoted bodies', () => {
      const s = statesOf(`
        CREATE FUNCTION a() RETURNS trigger LANGUAGE plpgsql ${GOOD} AS $$ BEGIN RETURN NEW; END $$;
        CREATE FUNCTION b() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$ ${GOOD};
        CREATE FUNCTION c() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        CREATE FUNCTION d() RETURNS int LANGUAGE sql AS 'SELECT ''x''::int' ${GOOD};
        CREATE PROCEDURE e() LANGUAGE sql ${GOOD} AS $$ SELECT 1 $$;
        CREATE FUNCTION public.f() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        CREATE FUNCTION "public"."G"() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
      `);
      for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'G']) {
        expect(s.get(k)?.hardened, k).toBe(true);
      }
    });

    it('rejects a missing setting, FROM CURRENT, a list without pg_temp, pg_temp not last, pg_catalog not first', () => {
      const s = statesOf(`
        CREATE FUNCTION a() RETURNS int LANGUAGE sql AS 'SELECT 1';
        CREATE FUNCTION b() RETURNS int LANGUAGE sql SET search_path FROM CURRENT AS 'SELECT 1';
        CREATE FUNCTION c() RETURNS int LANGUAGE sql SET search_path = public AS 'SELECT 1';
        CREATE FUNCTION d() RETURNS int LANGUAGE sql SET search_path = pg_catalog, pg_temp, public AS 'SELECT 1';
        CREATE FUNCTION e() RETURNS int LANGUAGE sql SET search_path = public, pg_catalog, pg_temp AS 'SELECT 1';
        CREATE FUNCTION f() RETURNS int LANGUAGE sql SET search_path TO 'pg_catalog, public, pg_temp' AS 'SELECT 1';
        CREATE FUNCTION g() RETURNS int LANGUAGE sql SET search_path = "$user", public AS 'SELECT 1';
        CREATE PROCEDURE h() LANGUAGE sql AS $$ SELECT 1 $$;
        CREATE FUNCTION public.i() RETURNS int LANGUAGE sql AS 'SELECT 1';
      `);
      for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
        expect(s.get(k)?.hardened, k).toBe(false);
      }
    });

    it('does not read a SET search_path that only appears inside a body or a string', () => {
      const s = statesOf(`
        CREATE FUNCTION a() RETURNS int LANGUAGE sql AS 'SELECT 1 -- SET search_path = pg_catalog, public, pg_temp';
        CREATE FUNCTION b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SET search_path = pg_catalog, public, pg_temp'; RETURN NEW; END $$;
        -- CREATE FUNCTION c() RETURNS int LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1';
        /* CREATE FUNCTION d() RETURNS int LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS 'SELECT 1'; */
      `);
      expect(s.get('a')?.hardened).toBe(false);
      expect(s.get('b')?.hardened).toBe(false);
      expect(s.has('c')).toBe(false);
      expect(s.has('d')).toBe(false);
    });

    it('CREATE OR REPLACE drops the setting; ALTER ... SET restores it; ALTER ... RESET / RESET ALL removes it', () => {
      const s = statesOf(`
        CREATE FUNCTION a() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        CREATE OR REPLACE FUNCTION a() RETURNS int LANGUAGE sql AS 'SELECT 2';
        CREATE FUNCTION b() RETURNS int LANGUAGE sql AS 'SELECT 1';
        ALTER FUNCTION b() ${GOOD};
        CREATE FUNCTION c() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        ALTER FUNCTION public.c() RESET search_path;
        CREATE FUNCTION d() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        ALTER FUNCTION d() RESET ALL;
        CREATE FUNCTION e() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        ALTER FUNCTION e() SET search_path FROM CURRENT;
        CREATE FUNCTION f() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        ALTER FUNCTION f() SET statement_timeout = '5s';
        CREATE PROCEDURE g() LANGUAGE sql ${GOOD} AS $$ SELECT 1 $$;
        ALTER ROUTINE g() RESET ALL;
        CREATE FUNCTION h() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        ALTER FUNCTION h() RENAME TO h2;
        CREATE FUNCTION k() RETURNS int LANGUAGE sql ${GOOD} AS 'SELECT 1';
        DROP FUNCTION IF EXISTS public.k();
      `);
      expect(s.get('a')?.hardened).toBe(false);
      expect(s.get('b')?.hardened).toBe(true);
      expect(s.get('c')?.hardened).toBe(false);
      expect(s.get('d')?.hardened).toBe(false);
      expect(s.get('e')?.hardened).toBe(false);
      expect(s.get('f')?.hardened).toBe(true);
      expect(s.get('g')?.hardened).toBe(false);
      expect(s.has('h')).toBe(false);
      expect(s.get('h2')?.hardened).toBe(true);
      expect(s.has('k')).toBe(false);
    });

    it('refuses a DO block that touches functions (it could hide anything)', () => {
      const s = statesOf(
        `DO $$ BEGIN EXECUTE 'ALTER FUNCTION a() SET search_path = x'; END $$;`,
      );
      expect([...s.values()].some((v) => !v.hardened)).toBe(true);
    });
  });
});
